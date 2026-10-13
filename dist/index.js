import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { connect } from "node:net";
import { connect as connect$1 } from "node:tls";

//#region src/shared/constants.ts
/** 插件唯一标识：同时作为 locale 命名空间、设置区块 id 与日志前缀。 */
const PLUGIN_ID = "dsh-tauri-notify-webhook";
const NOTIFY_CHANNEL_OFF = "off";
const NOTIFY_CHANNEL_EMAIL = "email";
const NOTIFY_CHANNEL_PUSHPLUS = "pushplus";
const NOTIFY_WEBHOOK_CHANNELS = [
	NOTIFY_CHANNEL_OFF,
	NOTIFY_CHANNEL_EMAIL,
	NOTIFY_CHANNEL_PUSHPLUS
];
const NOTIFY_SMTP_STARTTLS = "starttls";
const NOTIFY_SMTP_TLS = "tls";
const NOTIFY_SMTP_PLAIN = "plain";
const NOTIFY_SMTP_SECURITIES = [
	NOTIFY_SMTP_STARTTLS,
	NOTIFY_SMTP_TLS,
	NOTIFY_SMTP_PLAIN
];
const NOTIFY_SMTP_DEFAULT_PORT = 587;

//#endregion
//#region src/host/config/runtime.ts
/** sessionId → 最近一次 `turn/end` 的结束事实（内存态，不落盘）。 */
const turnEndFacts = /* @__PURE__ */ new Map();
function resetRuntime() {
	turnEndFacts.clear();
}

//#endregion
//#region src/host/events/session-event.ts
/**
* `session/event` 订阅：只挑 `turn/end` 记下结束原因。
*
* 事件回调签名是 `(session, event)`（与 `dsh-tauri-notification`、`dsh-tauri-worktree` 一致），
* 会话 id 取 `session.id`。原因缺失时记成空原因而不是直接返回：空原因在客户端不算异常，
* 于是退化成「照常推送」；直接返回会把上一回合的旧原因留在表里，那个旧原因若是 `aborted`，
* 就会把这一回合的推送也一并吞掉。
*/
function handleSessionEvent(session, event) {
	if (event?.type !== "turn/end") return;
	const sessionId = session?.id;
	if (typeof sessionId !== "string" || sessionId.length === 0) return;
	const reason = event?.data?.reason?.kind;
	const turn = event?.data?.turn;
	turnEndFacts.set(sessionId, {
		reason: typeof reason === "string" ? reason : "",
		turn: typeof turn === "number" ? turn : -1
	});
}

//#endregion
//#region src/host/routes/index.ts
/**
* host/routes —— 自建的最小 JSON 路由层。
*
* 桌面壳的 webServer 只接受 `{ kind, path, handler(req, res) }`：路由的具体语义
* （方法白名单、请求体解析、错误码）由插件自己定。这里只保留本插件需要的部分：
* 精确路径、显式方法集合、JSON 请求体、统一 `[状态码, 载荷]` 回包。
*
* 安全闸门与宿主 `guard` 同口径（本机地址 + 同源 + 改写类方法），因为
* `dsh-tauri` 导出的 `guard` 是 h3 形状的中间件，挂不到裸 `(req, res)` 上。
*/
/** 请求体上限：设置面板传的是配置对象，64 KiB 已经远超实际用量。 */
const MAX_ROUTE_BODY_BYTES = 64 * 1024;
/** 默认处理超时：与投递超时（15s）留足余量；超时不代表操作没生效。 */
const DEFAULT_TIMEOUT_MS = 3e4;
const LOOPBACK_IPS = new Set([
	"127.0.0.1",
	"::1",
	"::ffff:127.0.0.1"
]);
/** 改写类方法：与宿主 guard 同一张表，命中就要求本机来源 + 同源。 */
const MUTATION_METHODS = new Set([
	"POST",
	"PUT",
	"PATCH",
	"DELETE"
]);
/**
* 请求体只在这里解析成 JSON：设置路由是本插件唯一收体的地方，
* 其它路由用不上，也就不读流。
*/
function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		let settled = false;
		const fail = (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > limit) {
				fail(/* @__PURE__ */ new TypeError("body too large"));
				req.destroy?.();
				return;
			}
			chunks.push(chunk);
		});
		req.on("error", fail);
		req.on("end", () => {
			if (settled) return;
			settled = true;
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (text.length === 0) {
				resolve({});
				return;
			}
			try {
				const parsed = JSON.parse(text);
				resolve(parsed !== null && typeof parsed === "object" ? parsed : {});
			} catch {
				reject(/* @__PURE__ */ new SyntaxError("request body is not valid JSON"));
			}
		});
	});
}
/**
* 请求是否真的带了体：`content-length: 0` 的 POST（例如无参数的「测试推送」）
* 既不需要 content-type，也不该去读流——读了只会把连接挂住。
*/
function hasBody(req) {
	if (req.headers["transfer-encoding"] !== void 0) return true;
	const length = Number(req.headers["content-length"] ?? "0");
	return Number.isFinite(length) && length > 0;
}
/** 请求是否来自本机地址（同源校验的前置条件）。 */
function isLoopback(req) {
	return LOOPBACK_IPS.has(req.socket.remoteAddress ?? "");
}
/**
* 改写类请求额外要求同源：桌面壳里同源就是「本机的同一个 host:port」，
* 跨源页面即使能打到本机也不该改配置。
*/
function isSameOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	const host = req.headers.host;
	if (host === void 0 || host.length === 0) return false;
	try {
		return new URL(origin).origin === new URL(`http://${host}`).origin;
	} catch {
		return false;
	}
}
/**
* 把处理函数包成宿主可注册的路由。
*
* 状态码约定：`RouteHandler` 返回的一定是「已经处理过」的载荷（含业务错误），
* 路由层自己只负责协议级失败（405 / 413 / 415 / 403 / 504 / 500）。
*/
function jsonRoute(path, handler, options = {}) {
	const methods = options.methods ?? [];
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const { reject } = options;
	return {
		kind: "exact",
		path,
		handler: async (req, res) => {
			let responded = false;
			let timer;
			const send$1 = (status, payload) => {
				if (responded) return;
				responded = true;
				clearTimeout(timer);
				const text = JSON.stringify(payload);
				res.writeHead(status, {
					"content-type": "application/json; charset=utf-8",
					"x-content-type-options": "nosniff",
					"cache-control": "no-store"
				});
				res.end(req.method === "HEAD" ? void 0 : text);
			};
			timer = setTimeout(send$1, timeoutMs, 504, { error: "request timed out" });
			try {
				const method = (req.method ?? "GET").toUpperCase();
				const effective = method === "HEAD" ? "GET" : method;
				if (methods.length > 0 && !methods.includes(effective)) {
					const allow = methods.includes("GET") && !methods.includes("HEAD") ? [...methods, "HEAD"] : methods;
					res.setHeader("allow", allow.join(", "));
					send$1(405, { error: "method not allowed" });
					return;
				}
				if (reject !== void 0) {
					const status$1 = reject(req);
					if (status$1 === 401) {
						send$1(401, { error: "unauthorized" });
						return;
					}
					if (status$1 === 403) {
						send$1(403, { error: "forbidden" });
						return;
					}
				}
				if (MUTATION_METHODS.has(effective)) {
					if (!isLoopback(req)) {
						send$1(403, { error: "Change operation is limited to local machine (127.0.0.1) calls only" });
						return;
					}
					if (!isSameOrigin(req)) {
						send$1(403, { error: "cross-origin-request" });
						return;
					}
				}
				let body = {};
				if (MUTATION_METHODS.has(effective) && hasBody(req)) {
					if (!(req.headers["content-type"] ?? "").includes("application/json")) {
						send$1(415, { error: "content-type must be application/json" });
						return;
					}
					body = await readBody(req, MAX_ROUTE_BODY_BYTES);
				}
				const [status, payload] = await handler(body, req);
				send$1(status, payload);
			} catch (error) {
				send$1(500, { error: error instanceof Error ? error.message : String(error) });
			}
		}
	};
}

//#endregion
//#region compat/dsh-tauri.ts
/**
* compat/dsh-tauri —— 宿主侧 `dsh-tauri` 的本地垫片。
*
* 独立仓库不能依赖桌面仓的源码，而 npm 上的 `dsh-tauri` 不带 `dist/index.d.ts`。
* 这里按 1.0.0 的实际契约复刻本插件真正导入的成员：类型供 typecheck，实现供单测。
* 真实模块由桌面壳在运行时注入（构建产物里 `dsh-tauri` 保持 external），
* 这份文件不参与打包。
*/
/** 与运行时一致：`DSH_HOME` 环境变量优先，否则 `~/.dsh`。 */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
/** 编译期约束成员全为函数（散装状态留在模块作用域）；运行时原样返回。 */
function defineService(service) {
	return service;
}
/** rename 撞上 Windows 句柄占用时的重试上限与间隔（与运行时同值）。 */
const RENAME_MAX_RETRIES = 8;
const RENAME_RETRY_DELAY_MS = 25;
/** 原子写：同目录临时文件 + rename 覆盖，rename 撞 EPERM 时重试。 */
async function writeAtomic(target, value) {
	await mkdir(dirname(target), { recursive: true });
	const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(tmp, value, "utf8");
		for (let attempt = 0;; attempt += 1) try {
			await rename(tmp, target);
			return;
		} catch (error) {
			if (error.code !== "EPERM" || attempt >= RENAME_MAX_RETRIES) throw error;
			await setTimeout$1(RENAME_RETRY_DELAY_MS);
		}
	} catch (error) {
		await unlink(tmp).catch(() => void 0);
		throw error;
	}
}

//#endregion
//#region src/host/utils/error.ts
/** 投递异常统一成可读错误码：超时单独成码，其余用原始 message。 */
function deliveryErrorOf(error) {
	if (error instanceof Error) return error.name === "TimeoutError" ? "NOTIFY_TIMEOUT" : error.message;
	return String(error);
}

//#endregion
//#region src/host/service/notifier.utils.ts
const EHLO_NAME = hostname().replace(/[^a-z0-9.-]/gi, "-") || "localhost";
/** SMTP 续行以 `250-` 开头、末行以 `250 ` 收尾，只看首个换行会把多行应答截成半句。 */
function replyLength(buffer) {
	let offset = 0;
	while (offset < buffer.length) {
		const end = buffer.indexOf("\n", offset);
		if (end < 0) return -1;
		const line = buffer.slice(offset, end).replace(/\r$/, "");
		offset = end + 1;
		if (line.length === 3 || line[3] === " ") return offset;
	}
	return -1;
}
function expectReply(reply, codes) {
	const code = Number.parseInt(reply.slice(0, 3), 10);
	if (!codes.includes(code)) throw new Error(`NOTIFY_REMOTE: ${reply.replace(/\s+/g, " ").trim()}`);
	return reply;
}
/** `名字 <a@b>` 里 SMTP 命令只吃尖括号那一截。 */
function addressOf(value) {
	return (/<([^>]+)>/.exec(value)?.[1] ?? value).trim();
}
/** 中文主题必须走 RFC 2047，否则收信端乱码。 */
function encodeSubject(value) {
	return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
/** 正文 base64 传输，一次绕开行长限制、8bit 与点转义三件事。 */
function encodeBody(value) {
	return (Buffer.from(value, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}
/**
* 裸 socket → 会话：应答按块排队，命令按「写一行、读一次应答」推进。
* 超时与断开都记进 `failure` 并由下一次 `read` 抛出，失败点始终落在 await 上。
*/
function openSession(socket, timeoutMs) {
	socket.setTimeout(timeoutMs);
	let buffer = "";
	const queue = [];
	let resolveNext = null;
	let rejectNext = null;
	let failure = null;
	const settle = (reply) => {
		const resolve = resolveNext;
		resolveNext = null;
		rejectNext = null;
		if (resolve === null) queue.push(reply);
		else resolve(reply);
	};
	const fail = (error) => {
		failure = error;
		const reject = rejectNext;
		resolveNext = null;
		rejectNext = null;
		reject?.(error);
	};
	const onData = (chunk) => {
		buffer += chunk.toString("utf8");
		for (;;) {
			const length = replyLength(buffer);
			if (length < 0) return;
			const reply = buffer.slice(0, length);
			buffer = buffer.slice(length);
			settle(reply);
		}
	};
	const onError = (error) => fail(error);
	const onTimeout = () => fail(/* @__PURE__ */ new Error("NOTIFY_TIMEOUT"));
	const onClose = () => fail(/* @__PURE__ */ new Error("NOTIFY_REMOTE: 连接被对端关闭"));
	socket.on("data", onData);
	socket.on("error", onError);
	socket.on("timeout", onTimeout);
	socket.on("close", onClose);
	const read = () => {
		const reply = queue.shift();
		if (reply !== void 0) return Promise.resolve(reply);
		if (failure !== null) return Promise.reject(failure);
		return new Promise((resolve, reject) => {
			resolveNext = resolve;
			rejectNext = reject;
		});
	};
	return {
		read,
		async command(line, codes) {
			socket.write(`${line}\r\n`);
			return expectReply(await read(), codes);
		},
		close() {
			socket.destroy();
		},
		detach() {
			socket.off("data", onData);
			socket.off("error", onError);
			socket.off("timeout", onTimeout);
			socket.off("close", onClose);
			socket.setTimeout(0);
		}
	};
}
/** 隐式 TLS 等 `secureConnect`，明文与 STARTTLS 等 `connect`。 */
function connectSocket(host, port, security, timeoutMs) {
	return new Promise((resolve, reject) => {
		const secure = security === NOTIFY_SMTP_TLS;
		const socket = secure ? connect$1({
			host,
			port,
			servername: host
		}) : connect({
			host,
			port
		});
		const fail = (error) => {
			socket.destroy();
			reject(error);
		};
		const timer = setTimeout(() => fail(/* @__PURE__ */ new Error("NOTIFY_TIMEOUT")), timeoutMs);
		socket.once("error", fail);
		socket.once(secure ? "secureConnect" : "connect", () => {
			clearTimeout(timer);
			socket.off("error", fail);
			resolve(socket);
		});
	});
}
function upgradeSocket(socket, host, timeoutMs) {
	return new Promise((resolve, reject) => {
		const secured = connect$1({
			socket,
			servername: host
		});
		const fail = (error) => {
			secured.destroy();
			reject(error);
		};
		const timer = setTimeout(() => fail(/* @__PURE__ */ new Error("NOTIFY_TIMEOUT")), timeoutMs);
		secured.once("error", fail);
		secured.once("secureConnect", () => {
			clearTimeout(timer);
			secured.off("error", fail);
			resolve(secured);
		});
	});
}
/** 失败抛出的 `message` 已是 `NOTIFY_*` 错误码，调用方直接透传。 */
async function sendMail(delivery) {
	const { settings: settings$1, subject, body, timeoutMs } = delivery;
	let socket = await connectSocket(settings$1.host, settings$1.port, settings$1.security, timeoutMs);
	let session = openSession(socket, timeoutMs);
	try {
		expectReply(await session.read(), [220]);
		await session.command(`EHLO ${EHLO_NAME}`, [250]);
		if (settings$1.security === NOTIFY_SMTP_STARTTLS) {
			await session.command("STARTTLS", [220]);
			session.detach();
			socket = await upgradeSocket(socket, settings$1.host, timeoutMs);
			session = openSession(socket, timeoutMs);
			await session.command(`EHLO ${EHLO_NAME}`, [250]);
		}
		if (settings$1.username !== "") {
			await session.command("AUTH LOGIN", [334]);
			await session.command(Buffer.from(settings$1.username, "utf8").toString("base64"), [334]);
			await session.command(Buffer.from(settings$1.password, "utf8").toString("base64"), [235]);
		}
		await session.command(`MAIL FROM:<${addressOf(settings$1.from)}>`, [250]);
		await session.command(`RCPT TO:<${addressOf(settings$1.to)}>`, [250, 251]);
		await session.command("DATA", [354]);
		socket.write([
			`From: ${settings$1.from}`,
			`To: ${settings$1.to}`,
			`Subject: ${encodeSubject(subject)}`,
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=UTF-8",
			"Content-Transfer-Encoding: base64",
			"",
			encodeBody(body),
			".",
			""
		].join("\r\n"));
		expectReply(await session.read(), [250]);
	} finally {
		session.close();
	}
}

//#endregion
//#region src/shared/settings.ts
/** 加密方式决定默认端口：SSL/TLS 走 465，不加密走 25，STARTTLS 走 587。 */
function notifySmtpDefaultPort(security) {
	if (security === NOTIFY_SMTP_TLS) return 465;
	if (security === NOTIFY_SMTP_PLAIN) return 25;
	return NOTIFY_SMTP_DEFAULT_PORT;
}
/** 前端归一化 + 后端兜底共用：任何字段非法都退回默认值，不让坏数据进设置页或投递路径。 */
function normalizeNotifyWebhook(value) {
	const source = recordOf(value);
	const email = recordOf(source.email);
	const pushplus = recordOf(source.pushplus);
	const security = oneOf(NOTIFY_SMTP_SECURITIES, textOf(email.security), NOTIFY_SMTP_STARTTLS);
	return {
		channel: oneOf(NOTIFY_WEBHOOK_CHANNELS, textOf(source.channel), NOTIFY_CHANNEL_OFF),
		notifyOnComplete: source.notifyOnComplete !== false,
		notifyOnAbnormal: source.notifyOnAbnormal !== false,
		email: {
			host: textOf(email.host),
			port: portOf(email.port, security),
			security,
			username: textOf(email.username),
			password: textOf(email.password),
			from: textOf(email.from),
			to: textOf(email.to)
		},
		pushplus: { token: textOf(pushplus.token) }
	};
}
function recordOf(value) {
	return typeof value === "object" && value !== null ? value : {};
}
function textOf(value) {
	return typeof value === "string" ? value : "";
}
function oneOf(values, value, fallback) {
	return values.includes(value) ? value : fallback;
}
function portOf(value, security) {
	const port = typeof value === "string" ? Number(value) : value;
	return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535 ? port : notifySmtpDefaultPort(security);
}

//#endregion
//#region src/host/storage/index.ts
/**
* host/storage —— 插件自己的落盘格。
*
* 只存一份设置文档，所以不引入存储抽象层：路径固定在
* `$DSH_HOME/notify-webhook/settings`，写入走 `dsh-tauri` 的 `writeAtomic`
* （临时文件 + 改名，避免半个文件被读到）。
*/
const BASE$1 = "notify-webhook";
/** 设置文档的绝对路径。 */
function pathOf(key) {
	return join(DSH_HOME, BASE$1, key.replace(/:/g, "/"));
}
/**
* 读取文档。
*
* 文件不存在回 `null`（首次安装的正常路径），其它 IO 错误原样抛出：
* 权限、磁盘故障这类问题必须以错误码回给设置面板，不能伪装成「还没配置过」。
*/
async function getItem(key) {
	try {
		return parseDocument(await readFile(pathOf(key), "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}
/** 写入文档：目录先补齐，内容按 JSON 序列化后原子落盘。 */
async function setItem(key, value) {
	const target = pathOf(key);
	await mkdir(dirname(target), { recursive: true });
	await writeAtomic(target, stringifyDocument(value));
}
/** 空文件按「没有内容」处理；坏 JSON 原样交回，由归一化兜住非法值。 */
function parseDocument(text) {
	if (text.trim().length === 0) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
/** 与旧实现同口径：字符串原样写，其余对象走 JSON。 */
function stringifyDocument(value) {
	return typeof value === "string" ? value : JSON.stringify(value);
}
/** 设置服务消费的存储面（只保留读写两个动作）。 */
const storage = {
	getItem,
	setItem
};

//#endregion
//#region src/host/service/settings.ts
const DOCUMENT_KEY = "settings";
const settings = defineService({
	async load() {
		return normalizeNotifyWebhook(await storage.getItem(DOCUMENT_KEY));
	},
	async save(value) {
		const next = normalizeNotifyWebhook(value);
		await storage.setItem(DOCUMENT_KEY, next);
		return next;
	}
});

//#endregion
//#region src/host/service/notifier.ts
const DELIVERY_TIMEOUT_MS = 15e3;
const PUSHPLUS_ENDPOINT = "https://www.pushplus.plus/send";
const SUBJECT_FALLBACK = "DSH 通知";
const SUBJECT_MAX_CHARS = 200;
const TEST_TITLE = "DSH 通知推送测试";
const TEST_BODY = "这条消息由插件设置面板发出，收到即代表配置可用。";
const notifier = defineService({
	async deliver(sessionId, title, trigger) {
		const current = await settings.load();
		if (current.channel === NOTIFY_CHANNEL_OFF) return {
			ok: false,
			error: "NOTIFY_UNCONFIGURED: channel"
		};
		if (trigger === "completed" ? !current.notifyOnComplete : !current.notifyOnAbnormal) return {
			ok: false,
			error: "NOTIFY_DISABLED: trigger"
		};
		return send(current, subjectOf(title), bodyOf(title, sessionId, trigger));
	},
	async test() {
		const current = await settings.load();
		if (current.channel === NOTIFY_CHANNEL_OFF) return {
			ok: false,
			error: "NOTIFY_UNCONFIGURED: channel"
		};
		return send(current, TEST_TITLE, TEST_BODY);
	}
});
async function send(current, subject, body) {
	try {
		if (current.channel === NOTIFY_CHANNEL_EMAIL) {
			await sendEmail(current, subject, body);
			return { ok: true };
		}
		if (current.channel === NOTIFY_CHANNEL_PUSHPLUS) {
			await sendPushplus(current, subject, body);
			return { ok: true };
		}
		return {
			ok: false,
			error: "NOTIFY_UNCONFIGURED: channel"
		};
	} catch (error) {
		return {
			ok: false,
			error: deliveryErrorOf(error)
		};
	}
}
async function sendEmail(current, subject, body) {
	const { email } = current;
	if (email.host === "" || email.from === "" || email.to === "") throw new Error("NOTIFY_UNCONFIGURED: email");
	await sendMail({
		settings: email,
		subject,
		body,
		timeoutMs: DELIVERY_TIMEOUT_MS
	});
}
async function sendPushplus(current, subject, body) {
	const { token } = current.pushplus;
	if (token === "") throw new Error("NOTIFY_UNCONFIGURED: pushplus");
	const response = await fetch(PUSHPLUS_ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			token,
			title: subject,
			content: body,
			template: "txt"
		}),
		signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
	});
	if (!response.ok) throw new Error(`NOTIFY_REMOTE: HTTP ${response.status}`);
	const payload = await response.json();
	if (payload.code !== 200) throw new Error(`NOTIFY_REMOTE: ${String(payload.msg ?? payload.code ?? "pushplus")}`);
}
function subjectOf(title) {
	const text = sanitize(title);
	return text === "" ? SUBJECT_FALLBACK : text;
}
function bodyOf(title, sessionId, trigger) {
	const label = trigger === "completed" ? "任务完成" : "任务异常停止";
	const name$1 = sanitize(title);
	return name$1 === "" ? `${label}\n会话：${sessionId}` : `${label}\n会话：${name$1}\n${sessionId}`;
}
/** 换行折成空格：标题会进邮件头，裸换行等于头注入。 */
function sanitize(value) {
	return value.replace(/[\r\n]/g, " ").trim().slice(0, SUBJECT_MAX_CHARS);
}

//#endregion
//#region src/host/server/routes/delivery/post.ts
/** `POST /delivery`：客户端观察到回合结束后来敲一记，实际送信由 notifier 决定。 */
const deliveryPost = async (body) => {
	const payload = body;
	const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
	if (sessionId.length === 0) return [200, {
		ok: false,
		error: "NOTIFY_INVALID: sessionId"
	}];
	if (payload.trigger !== "completed" && payload.trigger !== "abnormal") return [200, {
		ok: false,
		error: "NOTIFY_INVALID: trigger"
	}];
	return [200, await notifier.deliver(sessionId, typeof payload.title === "string" ? payload.title : "", payload.trigger)];
};

//#endregion
//#region src/host/server/routes/settings/get.ts
/** `GET /settings`：读回宿主当前生效的设置。 */
const settingsGet = async () => {
	try {
		return [200, { settings: await settings.load() }];
	} catch (error) {
		return [200, { error: deliveryErrorOf(error) }];
	}
};

//#endregion
//#region src/host/server/routes/settings/post.ts
/** `POST /settings`：整份设置归一化后落盘，回包是归一化结果。 */
const settingsPost = async (body) => {
	const payload = body;
	if (payload.settings === void 0) return [200, { error: "NOTIFY_INVALID: settings" }];
	try {
		return [200, { settings: await settings.save(payload.settings) }];
	} catch (error) {
		return [200, { error: deliveryErrorOf(error) }];
	}
};

//#endregion
//#region src/host/server/routes/test/post.ts
/** `POST /test`：用当前已落盘的配置真发一条推送，结果原样回包。 */
const testPost = async () => {
	return [200, await notifier.test()];
};

//#endregion
//#region src/host/server/routes/turn-end/get.ts
/**
* `GET /turn-end?sessionId=…`：回答「这个会话的回合为什么结束」。
*
* 查不到就返回空对象（200）而不是 404：调用方只关心「是不是异常停止」，
* 未知一律按「不是」处理，没必要区分「没记录」与「会话不存在」。
*/
const turnEndGet = async (_body, req) => {
	const sessionId = new URL(req.url ?? "/", "http://localhost").searchParams.get("sessionId") ?? "";
	if (sessionId.length === 0) return [200, {}];
	const fact = turnEndFacts.get(sessionId);
	return [200, fact === void 0 ? {} : {
		reason: fact.reason,
		turn: fact.turn
	}];
};

//#endregion
//#region src/host/server/index.ts
/** 路由前缀：客户端 `apis/index.ts` 与这里的字面量必须逐字一致。 */
const BASE = "/api/tauri/notify-webhook";
/**
* 装配四条宿主路由：
*
* - `GET|POST /api/tauri/notify-webhook/settings`
* - `POST /api/tauri/notify-webhook/test`
* - `GET /api/tauri/notify-webhook/turn-end`
* - `POST /api/tauri/notify-webhook/delivery`
*
* 设置路由读写在同一条路径上：桌面壳的 webServer 按路径建表，同一路径注册两次
* 会抛 duplicate route，因此 GET 与 POST 合成一条 handler 按方法分流。
* 卸载时逐条收回注册句柄。
*/
function server(ctx) {
	const reject = (req) => ctx.connection?.requestRejection?.(req);
	const disposers = [
		ctx.webServer.register(jsonRoute(`${BASE}/settings`, (body, req) => {
			return req.method === "POST" ? settingsPost(body, req) : settingsGet(body, req);
		}, {
			methods: ["GET", "POST"],
			reject
		})),
		ctx.webServer.register(jsonRoute(`${BASE}/test`, testPost, {
			methods: ["POST"],
			reject
		})),
		ctx.webServer.register(jsonRoute(`${BASE}/turn-end`, turnEndGet, {
			methods: ["GET"],
			reject
		})),
		ctx.webServer.register(jsonRoute(`${BASE}/delivery`, deliveryPost, {
			methods: ["POST"],
			reject
		}))
	];
	return () => {
		for (const dispose of disposers) if (typeof dispose === "function") dispose();
	};
}

//#endregion
//#region src/host/apply.ts
function apply(ctx) {
	ctx.on("session/event", handleSessionEvent);
	ctx.effect(() => server(ctx), `${PLUGIN_ID}: routes`);
	ctx.effect(() => () => resetRuntime(), `${PLUGIN_ID}: host runtime`);
}

//#endregion
//#region src/index.ts
const name = PLUGIN_ID;
/** 宿主服务依赖：`webServer`（注册路由）与 `connection`（路由鉴权闸门，注册期必需）。 */
const inject = ["webServer", "connection"];

//#endregion
export { apply, inject, name };
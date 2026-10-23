/** 凭证同步密文（用户拍板 20260920）：口令加密副本随 data.json 同步到移动端，解决 SecretStorage 不跟随同步的问题。
 *  AES-GCM-256 + PBKDF2-SHA256（加密用 310k 迭代，OWASP 口径；迭代次数写进 blob，解密按 blob 参数派生，
 *  便于日后调高迭代而不破坏旧副本）；salt/IV 每次独立随机；
 *  口令不落盘、不进日志——data.json 只有密文，口令遗失只能重设副本。与宿主无关，单测直测。 */

const FORMAT_VERSION = 1;
const KDF_ID = "PBKDF2-SHA256";
const PBKDF2_ITERATIONS = 310_000;
/** 解密侧接受的迭代上限：防恶意 blob 用一个超大值拖死移动端。 */
const MAX_PBKDF2_ITERATIONS = 10_000_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

interface EncryptedBlob {
	v: number;
	kdf: string;
	iterations: number;
	salt: string;
	iv: string;
	ct: string;
}

function bytesToB64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function b64ToBytes(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
		"deriveKey",
	]);
	return crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** 加密明文凭证 → 密文 JSON 串（自描述格式，含版本/KDF 参数，供跨版本迁移判断）。 */
export async function encryptSecret(plain: string, passphrase: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
	const cipher = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(plain)),
	);
	const blob: EncryptedBlob = {
		v: FORMAT_VERSION,
		kdf: KDF_ID,
		iterations: PBKDF2_ITERATIONS,
		salt: bytesToB64(salt),
		iv: bytesToB64(iv),
		ct: bytesToB64(cipher),
	};
	return JSON.stringify(blob);
}

/** 解密密文副本；口令不对或密文损坏时抛错（错误信息不带敏感内容），由调用方映射为用户文案。 */
export async function decryptSecret(blob: string, passphrase: string): Promise<string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(blob);
	} catch {
		throw new Error("secret-crypto: blob is not valid JSON");
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		(parsed as EncryptedBlob).v !== FORMAT_VERSION ||
		(parsed as EncryptedBlob).kdf !== KDF_ID ||
		typeof (parsed as EncryptedBlob).salt !== "string" ||
		typeof (parsed as EncryptedBlob).iv !== "string" ||
		typeof (parsed as EncryptedBlob).ct !== "string"
	) {
		throw new Error("secret-crypto: unsupported blob format");
	}
	const record = parsed as EncryptedBlob;
	// 迭代次数必须来自 blob 且落在合理区间：正整数、不超过上限；非法值按格式不支持拒绝。
	if (
		!Number.isInteger(record.iterations) ||
		record.iterations <= 0 ||
		record.iterations > MAX_PBKDF2_ITERATIONS
	) {
		throw new Error("secret-crypto: unsupported blob format");
	}
	const key = await deriveKey(passphrase, b64ToBytes(record.salt), record.iterations);
	let plain: ArrayBuffer;
	try {
		plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(record.iv) as BufferSource }, key, b64ToBytes(record.ct) as BufferSource);
	} catch {
		throw new Error("secret-crypto: decrypt failed (wrong passphrase or corrupted blob)");
	}
	return new TextDecoder().decode(plain);
}

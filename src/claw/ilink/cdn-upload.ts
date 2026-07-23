/**
 * CDN 上传（vendor 自 @tencent-weixin/openclaw-weixin@2.4.6/dist/src/cdn/cdn-upload.js）
 *
 * 用 AES-128-ECB 加密文件后 POST 到 WeChat CDN。
 * 重要：导入路径改为本地 shim（无 openclaw 依赖）。
 */
import { encryptAesEcb } from './aes-ecb.js';
import { buildCdnUploadUrl } from './cdn-url.js';
import { logger } from './shim.js';
import { redactUrl } from './redact.js';

const UPLOAD_MAX_RETRIES = 3;

export type UploadBufferToCdnParams = {
  buf: Buffer;
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  label: string;
  aeskey: Buffer;
};

export type UploadBufferToCdnResp = {
  downloadParam: string;
};

/**
 * Upload one buffer to the Weixin CDN with AES-128-ECB encryption.
 * Returns the download encrypted_query_param from the CDN response.
 */
export async function uploadBufferToCdn(params: UploadBufferToCdnParams): Promise<UploadBufferToCdnResp> {
  const { buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, label, aeskey } = params;
  const ciphertext = encryptAesEcb(buf, aeskey);
  const trimmedFull = uploadFullUrl?.trim();
  let cdnUrl: string;
  if (trimmedFull) {
    cdnUrl = trimmedFull;
  } else if (uploadParam) {
    cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  } else {
    throw new Error(`${label}: CDN upload URL missing (need upload_full_url or upload_param)`);
  }
  logger.debug(`${label}: CDN POST url=${redactUrl(cdnUrl)} ciphertextSize=${ciphertext.length}`);

  let downloadParam: string | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      });
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get('x-error-message') ?? (await res.text());
        logger.error(`${label}: CDN client error attempt=${attempt} status=${res.status} errMsg=${errMsg}`);
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get('x-error-message') ?? `status ${res.status}`;
        logger.error(`${label}: CDN server error attempt=${attempt} status=${res.status} errMsg=${errMsg}`);
        throw new Error(`CDN upload server error: ${errMsg}`);
      }
      downloadParam = res.headers.get('x-encrypted-param') ?? undefined;
      if (!downloadParam) {
        logger.error(`${label}: CDN response missing x-encrypted-param header attempt=${attempt}`);
        throw new Error('CDN upload response missing x-encrypted-param header');
      }
      logger.debug(`${label}: CDN upload success attempt=${attempt}`);
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes('client error')) throw err;
      const cause = (err as any)?.cause ?? (err as any)?.code ?? '';
      if (attempt < UPLOAD_MAX_RETRIES) {
        logger.error(
          `${label}: attempt ${attempt} failed, retrying... url=${redactUrl(cdnUrl)} error=${String(err)}${
            cause ? ` cause=${cause}` : ''
          }`
        );
      } else {
        logger.error(
          `${label}: all ${UPLOAD_MAX_RETRIES} attempts failed url=${redactUrl(cdnUrl)} error=${String(err)}${
            cause ? ` cause=${cause}` : ''
          }`
        );
      }
    }
  }
  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
  }
  return { downloadParam };
}

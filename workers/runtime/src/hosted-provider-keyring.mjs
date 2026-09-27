const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function parseKeyVersion(value, name, fallback = null) {
  const raw = value === undefined || value === null || value === '' ? fallback : value;
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647) {
    throw new Error(`${name}_invalid`);
  }
  return version;
}

function normalizeBytes(value, errorCode) {
  try {
    // Runtime helpers can originate in another VM realm in the test harness.
    // Copy into this module's Uint8Array realm before WebCrypto consumption.
    return new Uint8Array(value);
  } catch {
    throw new Error(errorCode);
  }
}

/**
 * Key-version-aware AES-GCM helper for hosted provider credentials.
 *
 * Backwards compatible default:
 *   ONCE_PROVIDER_MASTER_KEY
 *   ONCE_PROVIDER_MASTER_KEY_VERSION=1 (implicit when omitted)
 *
 * Controlled rotation window:
 *   ONCE_PROVIDER_MASTER_KEY=<new key>
 *   ONCE_PROVIDER_MASTER_KEY_VERSION=<new version>
 *   ONCE_PROVIDER_PREVIOUS_MASTER_KEY=<old key>
 *   ONCE_PROVIDER_PREVIOUS_MASTER_KEY_VERSION=<old version>
 *
 * New ciphertext is always written with the current version. Decryption selects
 * one exact configured version; it never tries arbitrary keys. Unknown versions
 * and ambiguous keyring configuration fail closed.
 */
export class RuntimeHostedProviderKeyring {
  constructor({ env, bytesToBase64, base64ToBytes, aadFor }) {
    if (!env || typeof env !== 'object') {
      throw new TypeError('env must be an object');
    }
    if (typeof bytesToBase64 !== 'function') {
      throw new TypeError('bytesToBase64 must be a function');
    }
    if (typeof base64ToBytes !== 'function') {
      throw new TypeError('base64ToBytes must be a function');
    }
    if (typeof aadFor !== 'function') {
      throw new TypeError('aadFor must be a function');
    }

    this.env = env;
    this.bytesToBase64 = bytesToBase64;
    this.base64ToBytes = base64ToBytes;
    this.aadFor = aadFor;
    this.keyPromises = new Map();
  }

  getKeyring() {
    const currentVersion = parseKeyVersion(
      this.env.ONCE_PROVIDER_MASTER_KEY_VERSION,
      'provider_master_key_version',
      1,
    );
    const currentKey = String(this.env.ONCE_PROVIDER_MASTER_KEY || '').trim();
    if (!currentKey) {
      throw new Error('provider_master_key_missing');
    }

    const previousKey = String(this.env.ONCE_PROVIDER_PREVIOUS_MASTER_KEY || '').trim();
    const previousVersionRaw = String(
      this.env.ONCE_PROVIDER_PREVIOUS_MASTER_KEY_VERSION || '',
    ).trim();

    if (Boolean(previousKey) !== Boolean(previousVersionRaw)) {
      throw new Error('provider_previous_master_key_configuration_invalid');
    }

    let previousVersion = null;
    if (previousKey) {
      previousVersion = parseKeyVersion(
        previousVersionRaw,
        'provider_previous_master_key_version',
      );
      if (previousVersion === currentVersion) {
        throw new Error('provider_previous_master_key_version_conflict');
      }
    }

    return {
      currentVersion,
      currentKey,
      previousVersion,
      previousKey: previousKey || null,
    };
  }

  getCurrentKeyVersion() {
    return this.getKeyring().currentVersion;
  }

  getMasterKeyBytesForVersion(keyVersion) {
    const requestedVersion = parseKeyVersion(keyVersion, 'provider_key_version');
    const keyring = this.getKeyring();

    let encoded;
    if (requestedVersion === keyring.currentVersion) {
      encoded = keyring.currentKey;
    } else if (
      keyring.previousVersion !== null &&
      requestedVersion === keyring.previousVersion
    ) {
      encoded = keyring.previousKey;
    } else {
      throw new Error('provider_key_version_unsupported');
    }

    let decoded;
    try {
      decoded = this.base64ToBytes(encoded);
    } catch {
      throw new Error('provider_master_key_invalid');
    }
    const bytes = normalizeBytes(decoded, 'provider_master_key_invalid');
    if (bytes.byteLength !== 32) {
      throw new Error('provider_master_key_invalid_length');
    }
    return bytes;
  }

  async getCryptoKeyForVersion(keyVersion) {
    const version = parseKeyVersion(keyVersion, 'provider_key_version');
    if (!this.keyPromises.has(version)) {
      this.keyPromises.set(
        version,
        crypto.subtle.importKey(
          'raw',
          this.getMasterKeyBytesForVersion(version),
          { name: 'AES-GCM' },
          false,
          ['encrypt', 'decrypt'],
        ),
      );
    }
    return this.keyPromises.get(version);
  }

  async encryptConfig(customerId, providerName, versionId, config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('provider_config_invalid');
    }

    const keyVersion = this.getCurrentKeyVersion();
    const key = await this.getCryptoKeyForVersion(keyVersion);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = textEncoder.encode(JSON.stringify(config));
    const additionalData = normalizeBytes(
      this.aadFor(customerId, providerName, versionId),
      'provider_config_aad_invalid',
    );
    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData,
        tagLength: 128,
      },
      key,
      plaintext,
    );

    return {
      encryptedConfig: this.bytesToBase64(new Uint8Array(encrypted)),
      ivB64: this.bytesToBase64(iv),
      keyVersion,
    };
  }

  async decryptConfig(
    customerId,
    providerName,
    versionId,
    encryptedConfig,
    ivB64,
    keyVersion = 1,
  ) {
    const version = parseKeyVersion(keyVersion, 'provider_key_version');
    const key = await this.getCryptoKeyForVersion(version);

    let decodedIv;
    let decodedEncrypted;
    try {
      decodedIv = this.base64ToBytes(ivB64);
      decodedEncrypted = this.base64ToBytes(encryptedConfig);
    } catch {
      throw new Error('provider_config_ciphertext_invalid');
    }
    const iv = normalizeBytes(decodedIv, 'provider_config_ciphertext_invalid');
    const encryptedBytes = normalizeBytes(
      decodedEncrypted,
      'provider_config_ciphertext_invalid',
    );
    if (iv.byteLength !== 12) {
      throw new Error('provider_config_iv_invalid');
    }
    const additionalData = normalizeBytes(
      this.aadFor(customerId, providerName, versionId),
      'provider_config_aad_invalid',
    );

    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData,
          tagLength: 128,
        },
        key,
        encryptedBytes,
      );
    } catch {
      throw new Error('provider_config_decryption_failed');
    }

    let config;
    try {
      config = JSON.parse(textDecoder.decode(plaintext));
    } catch {
      throw new Error('provider_config_plaintext_invalid');
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('provider_config_plaintext_invalid');
    }
    return config;
  }
}

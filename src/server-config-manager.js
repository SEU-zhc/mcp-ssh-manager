import fs from 'fs';
import path from 'path';
import os from 'os';
import TOML from '@iarna/toml';
import { ConfigLoader } from './config-loader.js';
import { logger } from './logger.js';

export class ServerConfigManager {
  constructor({ envPath, tomlPath, preferToml = false, configLoader = new ConfigLoader() }) {
    this.envPath = envPath;
    this.tomlPath = tomlPath;
    this.preferToml = preferToml;
    this.configLoader = configLoader;
    this.servers = {};
    this.fileSignature = null;
  }

  async loadInitial() {
    await this.reload();
    return this.servers;
  }

  async getServers() {
    if (this.hasFileBackedConfigChanged()) {
      await this.reload();
    }

    return this.servers;
  }

  hasFileBackedConfigChanged() {
    const currentSignature = this.getFileSignature();
    return this.fileSignature !== currentSignature;
  }

  async reload() {
    const previousServers = this.servers;
    const previousSignature = this.fileSignature;

    try {
      const loadedServers = await this.configLoader.load({
        envPath: this.envPath,
        tomlPath: this.tomlPath,
        preferToml: this.preferToml
      });

      const nextServers = {};
      for (const [name, config] of loadedServers) {
        nextServers[name] = config;
      }

      this.servers = nextServers;
      this.fileSignature = this.getFileSignature();
      return this.servers;
    } catch (error) {
      this.servers = previousServers;
      this.fileSignature = previousSignature;
      logger.error('Failed to reload server configuration', { error: error.message });
      return this.servers;
    }
  }

  getFileSignature() {
    return [
      this.getSingleFileSignature(this.tomlPath),
      this.getSingleFileSignature(this.envPath)
    ].join('|');
  }

  getSingleFileSignature(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
      return `${filePath || ''}:missing`;
    }

    const stats = fs.statSync(filePath);
    return `${filePath}:${stats.mtimeMs}:${stats.size}`;
  }

  // Mirrors ConfigLoader.load()'s own default so an incremental write lands
  // in the same file a plain reload() would have picked up, even when this
  // manager was constructed with tomlPath left undefined.
  getEffectiveTomlPath() {
    return this.tomlPath || process.env.SSH_CONFIG_PATH || path.join(os.homedir(), '.codex', 'ssh-config.toml');
  }

  /**
   * Add or replace a single [ssh_servers.<name>] entry in the TOML config
   * file on disk, then reload so it's immediately usable. Unlike
   * exportToToml()/migrateEnvToToml(), this only touches the one entry —
   * every other server already in the file is preserved untouched.
   */
  async upsertServer(name, fields) {
    const normalizedName = name.toLowerCase();
    const tomlPath = this.getEffectiveTomlPath();
    const dir = path.dirname(tomlPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let doc = {};
    if (fs.existsSync(tomlPath)) {
      doc = TOML.parse(fs.readFileSync(tomlPath, 'utf8'));
    }
    if (!doc.ssh_servers) doc.ssh_servers = {};

    const entry = {
      host: fields.host,
      user: fields.user,
      port: fields.port || 22
    };
    if (fields.password) entry.password = fields.password;
    if (fields.keyPath) entry.key_path = fields.keyPath;
    if (fields.passphrase) entry.passphrase = fields.passphrase;
    if (fields.description) entry.description = fields.description;
    if (fields.platform) entry.platform = fields.platform;
    if (fields.defaultDir) entry.default_dir = fields.defaultDir;
    if (fields.networkTurbo) entry.network_turbo = true;

    doc.ssh_servers[normalizedName] = entry;
    fs.writeFileSync(tomlPath, TOML.stringify(doc), 'utf8');
    logger.info(`Wrote server "${normalizedName}" to ${tomlPath}`);

    await this.reload();
    return normalizedName;
  }

  /**
   * Remove a single [ssh_servers.<name>] entry from the TOML config file on
   * disk, then reload. Returns false if the file or entry didn't exist.
   */
  async removeServerEntry(name) {
    const normalizedName = name.toLowerCase();
    const tomlPath = this.getEffectiveTomlPath();
    if (!fs.existsSync(tomlPath)) return false;

    const doc = TOML.parse(fs.readFileSync(tomlPath, 'utf8'));
    if (!doc.ssh_servers || !(normalizedName in doc.ssh_servers)) return false;

    delete doc.ssh_servers[normalizedName];
    fs.writeFileSync(tomlPath, TOML.stringify(doc), 'utf8');
    logger.info(`Removed server "${normalizedName}" from ${tomlPath}`);

    await this.reload();
    return true;
  }
}

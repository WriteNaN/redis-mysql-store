import { createClient } from "redis";
import EventEmitter from "events";
import pino from "pino";
import { createConnection } from "mysql2/promise";

import type { RedisClientType } from "redis";
import type { Logger } from "pino";
import type { Connection } from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";

export default class Database extends EventEmitter {
  private client: RedisClientType;
  private logger: Logger;
  public redis: {
    get: (key: string) => Promise<string | null>;
    set: (
      key: string,
      value: string,
      { expire }: { expire?: number }
    ) => Promise<boolean>;
    flush: (type: "ALL" | "TEMP") => Promise<string>;
    delete: (keys: string[] | string) => Promise<number>;
  };
  private redisAutoFlushInterval?: number;
  private redisAutoTempFlushInterval?: number;

  private debug: boolean = false;

  private connection!: Connection;
  private sqlTable: string = "storekey";
  private sqlURI: string;
  public sql: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
    getAllKeys: () => Promise<string[]>;
  };

  public get: (key: string) => Promise<string | null>;
  public delete: (key: string) => Promise<void>;
  public set: (key: string, value: string) => Promise<void>;

  private defaultExpire: number;

  public redisClient: RedisClientType;
  public mysqlClient!: Connection;

  constructor({
    redisURI,
    sqlURI,
    config,
  }: {
    redisURI?: string;
    sqlURI?: string;
    config?: {
      redisAutoFlushInterval?: number;
      redisAutoTempFlushInterval?: number;
      debug?: boolean;
      sqlTable?: string;
      defaultExpire?: number;
    };
  }) {
    super();

    this.logger = pino({ level: "info" });

    this.doConfig(config);

    this.defaultExpire = config?.defaultExpire || 60 * 60;

    this.sqlURI = sqlURI as string;

    if (!redisURI) {
      throw Error("Keystore Error: No REDIS URI found!");
    } else if (!sqlURI) {
      throw Error("Keystore Error: No SQL URI found!");
    }

    this.client = createClient({ url: redisURI });
    this.init();

    this.cleanup();

    this.redis = this.getRedisApi();
    this.sql = this.getSqlApi();

    this.redisClient = this.client;

    this.get = async (key: string) => {
      const redisResponse = await this.redis.get(key);
      if (redisResponse) {
        return key;
      } else {
        const mySqlResponse = await this.sql.get(key);
        if (mySqlResponse) {
          this.redis.set(key, mySqlResponse, { expire: this.defaultExpire });
          return mySqlResponse;
        }
      }
      return null;
    };

    this.set = async (key: string, value: string) => {
      this.sql.set(key, value);
      this.redis.set(key, value, { expire: this.defaultExpire });
    };

    this.delete = async (key: string) => {
      this.sql.delete(key);
      this.redis.delete(key);
    };
  }

  private cleanup() {
    const cleanup = () => {
      this.closeDB();
      if (this.debug) console.log("CLOSED CONNECTION");
      process.exit();
    };
    process.on("exit", cleanup);
    process.on("SIGINT", cleanup);
    process.on("uncaughtException", cleanup);
    process.on("SIGTERM", cleanup);
  }

  private getSqlApi() {
    interface KeyValue {
      keyX: string;
      valueX: string;
    }

    return {
      get: async (key: string): Promise<string | null> => {
        const [rows] = await this.connection.query<RowDataPacket[]>({
          sql: `SELECT valueX from ${this.sqlTable} where keyX = ?`,
          values: [key],
        });
        const value = rows[0] ? (rows[0] as KeyValue).valueX : null;
        this.emit("get", { key, value, on: "SQL" });
        return value;
      },

      set: async (key: string, value: string): Promise<void> => {
        await this.connection.query({
          sql: `INSERT INTO ${this.sqlTable} (keyX, valueX) VALUES (?, ?) ON DUPLICATE KEY UPDATE valueX = VALUES(valueX)`,
          values: [key, value],
        });
        this.emit("set", { key, value, on: "SQL" });
      },

      delete: async (key: string): Promise<void> => {
        await this.connection.query({
          sql: `DELETE FROM ${this.sqlTable} WHERE keyX = ?`,
          values: [key],
        });
        // sql exclusive, gonna be annoying with redis cleanup
        this.emit("delete", { key, on: "SQL" });
      },

      getAllKeys: async (): Promise<string[]> => {
        const [rows] = await this.connection.query<RowDataPacket[]>({
          sql: `SELECT keyX FROM ${this.sqlTable}`,
        });
        return rows.map((row) => (row as KeyValue).keyX);
      },
    };
  }

  private getRedisApi() {
    return {
      get: async (key: string): Promise<string | null> => {
        if (this.debug) this.logger.info(`GETTING ${key} [REDIS]`);
        try {
          const value = await this.client.get(key);
          this.emit("get", { key, value, on: "REDIS" });
          if (this.debug) this.logger.info(`GOT ${value} FOR ${key} [REDIS]`);
          return value;
        } catch (e) {
          this.logger.error(e);
          return null;
        }
      },
      set: async (
        key: string,
        value: string,
        { expire }: { expire?: number }
      ): Promise<boolean> => {
        if (this.debug) this.logger.info(`SET ${key} AS ${value} [REDIS]`);
        try {
          await this.client.set(key, value);
          this.emit("set", { key, value, on: "REDIS" });
          if (expire) {
            await this.client.expire(key, expire);
          }
          return true;
        } catch (e) {
          this.logger.error(e);
          return false;
        }
      },
      flush: async (type: "ALL" | "TEMP"): Promise<string> => {
        if (type === "ALL") {
          return await this.client.flushAll();
        } else {
          try {
            this.client.keys("temp:*").then((keys) => {
              if (keys.length > 0) {
                this.logger.info(keys);
                this.redis.delete(keys);
                return "OK";
              }
            });
            return "ERR";
          } catch (e) {
            this.logger.error(e);
            return "ERR";
          }
        }
      },
      delete: async (keys: string[] | string): Promise<number> => {
        if (this.debug) this.logger.info(`DELETE: ${keys} [${typeof keys}]`);
        if (typeof keys === "string") {
          return this.client.del(keys);
        }
        return this.client.del([...keys]);
      },
    };
  }

  private doConfig(config?: {
    redisAutoFlushInterval?: number;
    redisAutoTempFlushInterval?: number;
    debug?: boolean;
    sqlTable?: string;
  }) {
    if (config?.redisAutoFlushInterval) {
      this.redisAutoFlushInterval = config.redisAutoFlushInterval;
    }

    if (config?.sqlTable) {
      this.sqlTable = config.sqlTable;
    }

    if (config?.redisAutoTempFlushInterval) {
      this.redisAutoTempFlushInterval = config.redisAutoTempFlushInterval;
    }

    if (config?.debug) {
      this.debug = config.debug;
    }
  }

  private async init() {
    try {
      if (this.debug) this.logger.info("CONNECTING TO REDIS...");
      await this.client.connect();
      if (this.debug) this.logger.info("CONNECTED TO REDIS!");
      if (this.debug) this.logger.info("CONNECTING TO SQL...");
      this.connection = await createConnection(this.sqlURI);
      this.mysqlClient = this.connection;
      await this.connection.connect();
      if (this.debug) this.logger.info("CONNECTED TO SQL!");
      await this.connection.execute(`
    CREATE TABLE IF NOT EXISTS \`${this.sqlTable}\` (
        id INT AUTO_INCREMENT PRIMARY KEY,
        keyX VARCHAR(255) UNIQUE,
        valueX VARCHAR(255)
    )
`);

      this.emit("ready");
      this.autoTempFlush();
      this.autoFlush();
    } catch (e) {
      this.logger.error(e);
    }
  }

  private autoTempFlush() {
    if (this.redisAutoTempFlushInterval) {
      if (this.redisAutoTempFlushInterval == -1) {
        return;
      } else {
        if (this.debug) this.logger.info("CHORE: FLUSH TEMP KEYS [REDIS]");
        setInterval(
          () => this.redis.flush("TEMP"),
          this.redisAutoTempFlushInterval
        );
      }
    }
  }

  private autoFlush() {
    if (this.redisAutoFlushInterval) {
      if (this.redisAutoFlushInterval == -1) {
        return;
      } else {
        setInterval(() => {
          if (this.debug) this.logger.info("CHORE: FLUSH ALL KEYS [REDIS]");
          this.redis.flush("ALL");
        }, this.redisAutoFlushInterval);
      }
    }
  }

  public closeDB(): void {
    try {
      this.client.disconnect();
      this.connection.destroy();
    } catch (e) {
      this.logger.error(e);
    }
  }
};
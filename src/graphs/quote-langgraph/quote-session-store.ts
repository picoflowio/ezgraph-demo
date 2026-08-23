import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type StoredMessage,
} from "@langchain/core/messages";
import { MongoClient, type Collection } from "mongodb";
import type { QuoteLanggraphStateType } from "./quote-langgraph.state.js";

type StoredQuoteLanggraphState = Omit<
  QuoteLanggraphStateType,
  "intakeMessages" | "incidentsMessages" | "presentMessages"
> & {
  intakeMessages: StoredMessage[];
  incidentsMessages: StoredMessage[];
  presentMessages: StoredMessage[];
};

export type QuoteSessionDocument = {
  version: 1;
  id: string;
  graphName: "QuoteLanggraph";
  state: StoredQuoteLanggraphState;
  createdAt: string;
  modifiedAt: string;
  expireAfter: number;
};

export interface QuoteSessionStore {
  readonly kind: "memory" | "sqlite" | "mongodb";
  get(id: string): Promise<QuoteSessionDocument | undefined>;
  set(document: QuoteSessionDocument): Promise<void>;
  delete(id: string): Promise<void>;
  close(): Promise<void>;
}

export class MemoryQuoteSessionStore implements QuoteSessionStore {
  readonly kind = "memory";
  private readonly documents = new Map<string, QuoteSessionDocument>();

  async get(id: string): Promise<QuoteSessionDocument | undefined> {
    return this.documents.get(id);
  }

  async set(document: QuoteSessionDocument): Promise<void> {
    this.documents.set(document.id, document);
  }

  async delete(id: string): Promise<void> {
    this.documents.delete(id);
  }

  async close(): Promise<void> {}
}

class SqliteQuoteSessionStore implements QuoteSessionStore {
  readonly kind = "sqlite";
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(databasePath: string) {
    const resolved =
      databasePath === ":memory:" ? databasePath : resolve(databasePath);
    if (resolved !== ":memory:") {
      mkdirSync(dirname(resolved), { recursive: true });
    }
    this.database = new DatabaseSync(resolved);
    this.database.exec("PRAGMA busy_timeout = 5000");
    if (resolved !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS quote_langgraph_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        document TEXT NOT NULL,
        modified_at TEXT NOT NULL
      )
    `);
  }

  async get(id: string): Promise<QuoteSessionDocument | undefined> {
    const row = this.database
      .prepare("SELECT document FROM quote_langgraph_sessions WHERE id = ?")
      .get(id) as { document: string } | undefined;
    return row
      ? (JSON.parse(row.document) as QuoteSessionDocument)
      : undefined;
  }

  async set(document: QuoteSessionDocument): Promise<void> {
    this.database
      .prepare(`
        INSERT INTO quote_langgraph_sessions (id, document, modified_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          document = excluded.document,
          modified_at = excluded.modified_at
      `)
      .run(document.id, JSON.stringify(document), document.modifiedAt);
  }

  async delete(id: string): Promise<void> {
    this.database
      .prepare("DELETE FROM quote_langgraph_sessions WHERE id = ?")
      .run(id);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}

class MongoQuoteSessionStore implements QuoteSessionStore {
  readonly kind = "mongodb";

  private constructor(
    private readonly client: MongoClient,
    private readonly collection: Collection<QuoteSessionDocument>,
  ) {}

  static async create(
    url: string,
    databaseName: string,
    collectionName: string,
  ): Promise<MongoQuoteSessionStore> {
    const client = new MongoClient(url);
    await client.connect();
    const collection = client
      .db(databaseName)
      .collection<QuoteSessionDocument>(collectionName);
    await collection.createIndex({ id: 1 }, { unique: true });
    return new MongoQuoteSessionStore(client, collection);
  }

  async get(id: string): Promise<QuoteSessionDocument | undefined> {
    return (await this.collection.findOne({ id })) ?? undefined;
  }

  async set(document: QuoteSessionDocument): Promise<void> {
    await this.collection.replaceOne({ id: document.id }, document, {
      upsert: true,
    });
  }

  async delete(id: string): Promise<void> {
    await this.collection.deleteOne({ id });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export async function createMongoQuoteSessionStore(options: {
  url: string;
  databaseName: string;
  collectionName: string;
}): Promise<QuoteSessionStore> {
  return MongoQuoteSessionStore.create(
    options.url,
    options.databaseName,
    options.collectionName,
  );
}

export async function createQuoteSessionStoreFromEnvironment(): Promise<QuoteSessionStore> {
  const kind = (process.env.SESSION_STORE ?? "memory").trim().toLowerCase();
  if (kind === "memory") return new MemoryQuoteSessionStore();
  if (kind === "sqlite") {
    return new SqliteQuoteSessionStore(
      process.env.SQLITE_DB_PATH?.trim() || "./data/sessions.sqlite",
    );
  }
  if (kind === "mongodb" || kind === "mongo") {
    const url = process.env.MONGODB_URL?.trim();
    const databaseName = process.env.MONGODB_NAME?.trim();
    const collectionName = process.env.MONGODB_COLLECTION?.trim();
    if (!url || !databaseName || !collectionName) {
      throw new Error(
        "MongoDB session persistence requires MONGODB_URL, MONGODB_NAME, and MONGODB_COLLECTION.",
      );
    }
    return createMongoQuoteSessionStore({ url, databaseName, collectionName });
  }
  throw new Error(
    `QuoteLanggraph does not support SESSION_STORE '${kind}'. Use memory, sqlite, or mongodb.`,
  );
}

export function serializeQuoteState(
  state: QuoteLanggraphStateType,
): StoredQuoteLanggraphState {
  return {
    ...state,
    intakeMessages: mapChatMessagesToStoredMessages(state.intakeMessages),
    incidentsMessages: mapChatMessagesToStoredMessages(state.incidentsMessages),
    presentMessages: mapChatMessagesToStoredMessages(state.presentMessages),
  };
}

export function hydrateQuoteState(
  state: StoredQuoteLanggraphState,
): QuoteLanggraphStateType {
  return {
    ...state,
    intakeMessages: mapStoredMessagesToChatMessages(state.intakeMessages),
    incidentsMessages: mapStoredMessagesToChatMessages(state.incidentsMessages),
    presentMessages: mapStoredMessagesToChatMessages(state.presentMessages),
  };
}

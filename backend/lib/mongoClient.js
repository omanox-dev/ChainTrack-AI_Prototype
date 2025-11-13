require('dotenv').config();
const { MongoClient } = require('mongodb');

let client = null;
let db = null;
let memoryServer = null;

async function connect() {
  if (db) return db;

  const uri = process.env.MONGO_URI || '';
  const useMock = (process.env.USE_MOCK_DB || 'true').toLowerCase() === 'true';

  if (uri && !useMock) {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(process.env.MONGO_DB_NAME || 'chaintrack');
    console.log('MongoClient: connected to real Mongo host');
    return db;
  }

  // In-memory fallback for local demos (mongodb-memory-server)
  try {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    memoryServer = await MongoMemoryServer.create();
    const memUri = memoryServer.getUri();
    client = new MongoClient(memUri);
    await client.connect();
    db = client.db(process.env.MONGO_DB_NAME || 'chaintrack_demo');
    console.log('MongoClient: started in-memory mongo for demo (mock)');
    return db;
  } catch (e) {
    // If mongodb-memory-server not installed or fails, throw so caller can handle
    throw new Error('Failed to start in-memory MongoDB: ' + String(e));
  }
}

function getDb() {
  if (!db) throw new Error('MongoClient: not connected yet. Call connect() first.');
  return db;
}

async function close() {
  try {
    if (client) await client.close();
    if (memoryServer) await memoryServer.stop();
  } finally {
    client = null;
    db = null;
    memoryServer = null;
  }
}

module.exports = { connect, getDb, close };

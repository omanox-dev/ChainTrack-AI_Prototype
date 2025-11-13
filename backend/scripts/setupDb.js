require('dotenv').config();
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI || '';
const DB_NAME = process.env.MONGO_DB_NAME || 'chaintrack';

async function run() {
  if (!MONGO_URI) {
    console.error('MONGO_URI not set in environment. Set it to your Atlas connection string and re-run.');
    process.exit(1);
  }
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    console.log('Connected to Mongo:', mask(MONGO_URI));
    const db = client.db(DB_NAME);

    const collectionsToEnsure = ['analyses', 'transactions', 'addresses'];
    for (const name of collectionsToEnsure) {
      const exists = await db.listCollections({ name }).hasNext();
      if (!exists) {
        await db.createCollection(name);
        console.log('Created collection:', name);
      } else {
        console.log('Collection exists:', name);
      }
    }

    // Helper: create index only if a matching key spec doesn't already exist
    async function ensureIndex(col, keySpec, opts) {
      const existing = await db.collection(col).indexes();
      const wanted = JSON.stringify(keySpec);
      const found = existing.find(ix => JSON.stringify(ix.key) === wanted);
      if (found) {
        console.log(`Index exists on ${col}:`, found.name);
        return found.name;
      }
      try {
        const name = await db.collection(col).createIndex(keySpec, opts || {});
        console.log(`Created index on ${col}:`, name);
        return name;
      } catch (e) {
        // If an index with the same key already exists, ignore the error.
        if (e && e.code === 86) {
          console.warn(`Index conflict for ${col} ${wanted} — skipping (already exists)`);
          return null;
        }
        throw e;
      }
    }

    await ensureIndex('analyses', { txHash: 1 }, { unique: true });
    await ensureIndex('transactions', { txHash: 1 }, { unique: true });
    await ensureIndex('transactions', { from: 1, to: 1, value: -1 });
    await ensureIndex('addresses', { address: 1 }, { unique: true });
    await ensureIndex('analyses', { createdAt: -1 });
    console.log('Indexes created/ensured.');

    const demoTx = {
      txHash: '0xDEMO_TX_HASH_1',
      network: 'ethereum',
      summary: 'Demo analysis - incoming funds',
      anomaly: false,
      feePrediction: { gasUsed: 21000, gasPriceGwei: 30 },
      recommendations: ['Monitor large transfers', 'Verify counterparty'],
      createdAt: new Date(),
    };
    const res = await db.collection('analyses').updateOne(
      { txHash: demoTx.txHash },
      { $setOnInsert: demoTx },
      { upsert: true }
    );
    console.log('Seeded demo analysis (upsert):', res.upsertedId ? 'created' : 'already exists');

    console.log('DB setup complete:', DB_NAME);
  } catch (err) {
    console.error('Error during DB setup:', err);
    process.exit(2);
  } finally {
    await client.close();
  }
}

function mask(uri) {
  return uri.replace(/(\/\/)(.*?@)/, '$1<redacted>@');
}

if (require.main === module) run();
module.exports = run;

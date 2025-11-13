require('dotenv').config();
const { MongoClient } = require('mongodb');

// Safety: require --force flag or DROP_FORCE=true in env to actually drop
const args = process.argv.slice(2);
const hasForce = args.includes('--force') || process.env.DROP_FORCE === 'true';

async function run() {
  if (!hasForce) {
    console.log('DROP aborted: this script requires --force flag or DROP_FORCE=true in environment to run.');
    console.log('Example: DROP_FORCE=true node ./scripts/dropCollections.js');
    process.exit(0);
  }

  const MONGO_URI = process.env.MONGO_URI || '';
  const DB_NAME = process.env.MONGO_DB_NAME || 'chaintrack';
  if (!MONGO_URI) {
    console.error('MONGO_URI not set. Set it in .env or export it in the environment.');
    process.exit(1);
  }

  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    console.log('Connected to', DB_NAME);

    const toDrop = ['analyses', 'transactions', 'addresses'];
    for (const name of toDrop) {
      try {
        const exists = await db.listCollections({ name }).hasNext();
        if (exists) {
          await db.collection(name).drop();
          console.log('Dropped collection:', name);
        } else {
          console.log('Collection not found (skipping):', name);
        }
      } catch (e) {
        console.error('Error dropping', name, e.message || e);
      }
    }

    console.log('Drop operation complete.');
  } catch (err) {
    console.error('Error connecting to Mongo:', err);
    process.exit(2);
  } finally {
    await client.close();
  }
}

if (require.main === module) run();

module.exports = run;

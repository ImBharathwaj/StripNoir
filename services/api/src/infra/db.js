const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;
const databaseReadUrl = process.env.DATABASE_READ_URL;

const pool = new Pool(
  databaseUrl
    ? { connectionString: databaseUrl }
    : undefined
);

const poolRead =
  databaseReadUrl && databaseReadUrl !== databaseUrl
    ? new Pool({ connectionString: databaseReadUrl })
    : pool;

async function checkPostgres() {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    client.release();
  }
}

async function checkPostgresRead() {
  if (poolRead === pool) {
    return { ok: true, mode: 'primary_only' };
  }
  const client = await poolRead.connect();
  try {
    await client.query('SELECT 1');
    return { ok: true, mode: 'replica' };
  } catch (error) {
    return { ok: false, mode: 'replica', error: error.message };
  } finally {
    client.release();
  }
}

async function closePostgres() {
  await pool.end();
  if (poolRead !== pool) {
    await poolRead.end();
  }
}

module.exports = {
  checkPostgres,
  checkPostgresRead,
  closePostgres,
  pool,
  poolRead
};

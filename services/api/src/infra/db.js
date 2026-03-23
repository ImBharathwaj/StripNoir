const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;

const pool = new Pool(
  databaseUrl
    ? { connectionString: databaseUrl }
    : undefined
);

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

async function closePostgres() {
  await pool.end();
}

module.exports = {
  checkPostgres,
  closePostgres,
  pool
};

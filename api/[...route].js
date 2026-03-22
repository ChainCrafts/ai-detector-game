const { ensureSeedLoaded, handleRequest } = require('../server');

module.exports = async (req, res) => {
  try {
    await ensureSeedLoaded();
    await handleRequest(req, res);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: error.message || 'Internal server error.' }));
  }
};

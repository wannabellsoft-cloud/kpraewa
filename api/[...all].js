// Vercel serverless wrapper — exports the Express app as a handler.
const { createApp } = require('../server');

const app = createApp();

module.exports = (req, res) => app(req, res);

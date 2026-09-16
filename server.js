// Local development only. Vercel uses api/index.js instead.
const app = require('./src/app');

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`G Points running on http://localhost:${PORT}`));

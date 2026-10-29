// Vercel serverless entry: every /api/* request is routed here (vercel.json) and handled by the Express app.
// The site itself (public/) is served by Vercel as static files.
export { default } from '../server/index.js';

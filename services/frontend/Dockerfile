FROM node:20-bookworm-slim AS base
WORKDIR /app

# Install deps first for better layer caching.
# Use development so devDependencies (e.g. TypeScript types) install; Tailwind/PostCSS are in dependencies for Next CSS pipeline.
ENV NODE_ENV=development
COPY package.json package-lock.json* ./
RUN npm ci

# Copy the rest of the app
COPY . .

EXPOSE 3000

# Dev by default (compose uses this)
CMD ["npm", "run", "dev"]


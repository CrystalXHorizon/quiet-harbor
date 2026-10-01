FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts ./scripts
COPY public ./public
RUN npm run build
ENV HOST=0.0.0.0 PORT=4173 NODE_ENV=production
USER node
EXPOSE 4173
CMD ["node", "scripts/preview.mjs"]

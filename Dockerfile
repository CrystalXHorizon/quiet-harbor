FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs harness.mjs ./
COPY public ./public
ENV HOST=0.0.0.0 PORT=4173 NODE_ENV=production
USER node
EXPOSE 4173
CMD ["node", "server.mjs"]

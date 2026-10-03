FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts ./scripts
COPY public ./public
ARG PUBLIC_SUPABASE_URL
ARG PUBLIC_SUPABASE_ANON_KEY
RUN PUBLIC_SUPABASE_URL="$PUBLIC_SUPABASE_URL" PUBLIC_SUPABASE_ANON_KEY="$PUBLIC_SUPABASE_ANON_KEY" npm run build
ENV HOST=0.0.0.0 PORT=4173 NODE_ENV=production
USER node
EXPOSE 4173
CMD ["node", "scripts/preview.mjs"]

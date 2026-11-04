# The backend URL and publishable key are read by Vite at build time and baked
# into the bundle, so they are build args rather than runtime environment. Both
# are public by design - the publishable key is the one browsers are meant to
# hold - but the image is therefore specific to one backend.
FROM node:20-alpine AS build
ARG NUVIO_SUPABASE_URL
ARG NUVIO_SUPABASE_ANON_KEY
# Stated separately so the account backend can be changed without sending
# playback at a host that has no proxy on it.
ARG NUVIO_MEDIA_PROXY_URL
ENV NUVIO_SUPABASE_URL=$NUVIO_SUPABASE_URL
ENV NUVIO_SUPABASE_ANON_KEY=$NUVIO_SUPABASE_ANON_KEY
ENV NUVIO_MEDIA_PROXY_URL=$NUVIO_MEDIA_PROXY_URL
WORKDIR /app
# Copied first so a source-only change does not reinstall the dependency tree.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM caddy:2.10.0-alpine
COPY --from=build /app/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80

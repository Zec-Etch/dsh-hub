FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8790 \
    DSH_HUB_DATA=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && mkdir -p /data \
    && chown node:node /data \
    && chmod 700 /data

COPY --chown=node:node server.mjs mux.mjs ./
COPY --chown=node:node public/ ./public/

USER node
EXPOSE 8790
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Arguments replace CMD, so `docker run ... IMAGE set-password` initializes /data.
ENTRYPOINT ["node", "server.mjs"]
CMD ["serve"]

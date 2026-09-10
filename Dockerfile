# Absolute minimal diagnostic image — no Next.js build, no Prisma, no
# multi-stage build, just Node + one plain JS file. Used on the
# `minimal-test` branch to eliminate Next.js/the standalone build output
# entirely as a possible cause of this service's persistent, log-free 502.
FROM node:22-alpine
WORKDIR /app
COPY minimal-server.js ./
EXPOSE 10000
ENV PORT=10000
CMD ["node", "minimal-server.js"]

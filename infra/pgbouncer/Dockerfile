FROM alpine:3.20

RUN apk add --no-cache pgbouncer bash su-exec

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 6432

ENTRYPOINT ["/entrypoint.sh"]

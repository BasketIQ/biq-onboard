# Multi-stage build:
#   1. Node builder compiles the Vite app + embed library.
#   2. Python runtime serves the static app and embed library.

FROM node:23-slim AS builder
WORKDIR /build
COPY app/package*.json ./
RUN npm install
COPY app/ ./
RUN npm run build && npm run build:lib

FROM python:3.12-slim
WORKDIR /srv
COPY vendor/biq_observability-0.1.0-py3-none-any.whl /opt/biq_observability-0.1.0-py3-none-any.whl
RUN pip install --no-cache-dir /opt/biq_observability-0.1.0-py3-none-any.whl

# wheelhouse/ is prefetched from the private GAR Python index by deploy.yml
# (ADR-009). Install biq-core offline first, then the server.
COPY wheelhouse/ /srv/wheelhouse/
COPY server/ /srv/server/
RUN pip install --no-cache-dir --no-index --find-links /srv/wheelhouse biq-core[org] \
 && pip install --no-cache-dir "/srv/server[firestore]"

COPY --from=builder /dist/app/ /srv/static/
COPY --from=builder /dist/embed/ /srv/static/embed/
ENV STATIC_DIR=/srv/static
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn biq_onboard_server.app:app --host 0.0.0.0 --port ${PORT}"]

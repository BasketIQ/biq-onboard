FROM python:3.12-slim
WORKDIR /srv

COPY wheelhouse/ /srv/wheelhouse/
COPY server/ /srv/server/
RUN pip install --no-cache-dir --no-index --find-links /srv/wheelhouse biq-core[org] \
 && pip install --no-cache-dir "/srv/server[firestore]"

ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn biq_onboard_server.app:app --host 0.0.0.0 --port ${PORT}"]

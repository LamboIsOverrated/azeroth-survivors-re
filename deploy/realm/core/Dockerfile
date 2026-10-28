# syntax=docker/dockerfile:1
FROM ghcr.io/arnesen/wenilla-realm-mangos@sha256:837e0cb76f8c95f209ba8d53fd5de7c8deced8fd8908b532ed2cc34e393b8348
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && rmdir /config && ln -s /realm-data/config /config
COPY deploy/realm/core/runtime.py /opt/railway-core/runtime.py
COPY deploy/realm/core/upstreams.env deploy/realm/core/PROVENANCE.md /opt/railway-core/
ENV PYTHONUNBUFFERED=1 PORT=8080
EXPOSE 8080 3724 8085 7878
STOPSIGNAL SIGTERM
ENTRYPOINT ["python3", "/opt/railway-core/runtime.py"]
CMD ["serve"]

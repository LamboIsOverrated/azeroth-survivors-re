# syntax=docker/dockerfile:1
FROM ghcr.io/arnesen/wenilla-realm-mangos@sha256:837e0cb76f8c95f209ba8d53fd5de7c8deced8fd8908b532ed2cc34e393b8348
USER root
# This wrapper-only release must retain the exact native TEST executables.
RUN echo '8dfc1dbaeb42c04cc57f1d042e79b6092d6e5f8461cc5ec808ecf0cb3249ddbd  /opt/mangos/bin/mangosd' > /tmp/native-core.sha256 \
    && echo 'c8cf32aa0aeea1dc80d2a23c2163d6e313f21017567bf9d7f414015aa396bc27  /opt/mangos/bin/realmd' >> /tmp/native-core.sha256 \
    && sha256sum --check /tmp/native-core.sha256 && rm /tmp/native-core.sha256
RUN apt-get update && apt-get install -y --no-install-recommends python3 curl unzip smpq \
    && rm -rf /var/lib/apt/lists/* \
    && rmdir /config && ln -s /realm-data/config /config
COPY runtime.py adt_repair.py repair_client.py /opt/railway-core/
COPY upstreams.env PROVENANCE.md /opt/railway-core/
ENV PYTHONUNBUFFERED=1 PORT=8080
EXPOSE 8080 3724 8085 7878
STOPSIGNAL SIGTERM
ENTRYPOINT ["python3", "/opt/railway-core/runtime.py"]
CMD ["serve"]

# syntax=docker/dockerfile:1
FROM ghcr.io/arnesen/wenilla-realm-mangos@sha256:837e0cb76f8c95f209ba8d53fd5de7c8deced8fd8908b532ed2cc34e393b8348
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 curl unzip smpq \
    && rm -rf /var/lib/apt/lists/* \
    && rmdir /config && ln -s /realm-data/config /config
COPY runtime.py adt_repair.py repair_client.py world_inventory.py extraction-profile.json /opt/railway-core/
COPY upstreams.env PROVENANCE.md /opt/railway-core/
ENV PYTHONUNBUFFERED=1 PORT=8080 CORE_PLAYERBOTS_COMPILED=1 CORE_AHBOT_COMPILED=1 REALM_BRIDGE_TEST_ENABLE=0 CORE_BROWSER_MOVEMENT_COMPILED=0 REALM_BROWSER_MOVEMENT_ENABLE=0
EXPOSE 8080 3724 8085 7878
STOPSIGNAL SIGTERM
ENTRYPOINT ["python3", "/opt/railway-core/runtime.py"]
CMD ["serve"]

import { defineRailway, github, image, preserve, project, service, volume } from "railway/iac";

export const partial = "browser-mmo";

export default defineRailway((ctx) => {
  if (ctx.environment !== "pvp-staging") throw new Error("This file manages pvp-staging only; production requires a separately reviewed environment definition.");
  const realmWebVolume = volume("realm-web-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "iad", sizeMB: 50000 });
  const realmCoreVolume = volume("realm-core-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "iad", sizeMB: 50000 });
  const realmDbVolume = volume("realm-db-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "iad", sizeMB: 50000 });
  const realmDb = service("realm-db", {
    source: image("mariadb:11.4@sha256:d1891ede5a559f1086f55053bb8cc1569b0298338c4d72d71725a7f74f6ba620"),
    replicas: { "iad": 1 },
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10, sleepApplication: false, limitOverride: { containers: { cpu: 1, memoryBytes: 2000000000 } } },
    volumeMounts: { "/var/lib/mysql": realmDbVolume },
    env: { MARIADB_ROOT_PASSWORD: preserve() },
  });
  const realmCore = service("realm-core", {
    source: github("LamboIsOverrated/azeroth-survivors-re", { branch: "deploy/realm-core", rootDirectory: "/deploy/realm/core", checkSuites: false }),
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/healthz",
    replicas: { "iad": 1 },
    deploy: { drainingSeconds: 120, restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10, sleepApplication: false, limitOverride: { containers: { cpu: 4, memoryBytes: 6000000000 } } },
    volumeMounts: { "/realm-data": realmCoreVolume },
    env: { DB_HOST: preserve(), DB_MANGOS_PASSWORD: preserve(), DB_PORT: preserve(), DB_REALMWEB_PASSWORD: preserve(), DB_ROOT_PASSWORD: preserve(), PORT: preserve(), REALM_DOMAIN: preserve(), SOAP_ADMIN_PASSWORD: preserve(), SOAP_ADMIN_USERNAME: preserve() },
  });
  const realmWeb = service("realm-web", {
    source: github("LamboIsOverrated/azeroth-survivors-re", { branch: "feat/browser-pvp-mmo", rootDirectory: "/deploy/realm", checkSuites: false }),
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/healthz",
    deploy: { drainingSeconds: 30, healthcheckTimeout: 120, restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10, sleepApplication: false, limitOverride: { containers: { cpu: 2, memoryBytes: 4000000000 } } },
    replicas: { "iad": 1 },
    volumeMounts: { "/state": realmWebVolume },
    env: { DOWNLOAD_GAME_DATA: preserve(), ECONOMY_SOLANA_RPC_URL: preserve(), ECONOMY_TEST_ALLOCATION_UNITS: preserve(), MANGOSD_HOST: preserve(), MARIADB_URL: preserve(), MMO_BUNDLE_URL: preserve(), MMO_BUNDLE_SHA256: preserve(), PORT: preserve(), RAILWAY_DOCKERFILE_PATH: "Dockerfile", REALMD_HOST: preserve(), REALM_PUBLIC_URL: preserve(), REALM_REMOTE_CONFIG: preserve(), SOAP_BOOTSTRAP_PASS: preserve(), SOAP_BOOTSTRAP_USER: preserve(), SOAP_URL: preserve(), TRUST_RAILWAY_EDGE: preserve() },
  });

  return project("azeroth-survivors", {
    resources: [realmDb, realmCore, realmWeb, realmWebVolume, realmCoreVolume, realmDbVolume],
  });
});


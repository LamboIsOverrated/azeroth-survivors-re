import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const revision = "de8f72993b9e1faa1bf92dd5505f3daec5cea3ce";
const files = [
  "src/shared/Database/Database.h",
  "src/shared/Database/Database.cpp",
  "src/shared/Database/DatabaseMysql.h",
  "src/shared/Database/SqlDelayThread.h",
  "src/shared/Database/SqlDelayThread.cpp",
  "src/game/Chat/Chat.h",
  "src/game/Chat/Chat.cpp",
  "src/game/Chat/Level3.cpp",
  "src/game/World/World.cpp",
  "src/game/World/World.h",
  "src/mangosd/MaNGOSsoap.cpp",
];
const before = join(here, ".audit/before"),
  after = join(here, ".audit/after");
const manifest = { revision, files: {} };
const sha = (text) => createHash("sha256").update(text).digest("hex");
function replace(text, from, to) {
  if (text.split(from).length !== 2)
    throw new Error("Pinned source anchor is not unique: " + from);
  return text.replace(from, to);
}
const handler = `
// TEST-only world-owner bridge. LIVE game issuance is not yet reserve-backed.
bool ChatHandler::HandleRealmBridgeCommand(char* args)
{
    RealmBridge::Request request;
    if (GetSession() || !RealmBridge::Parse(args, request)) return false;
    if (request.action == "apply")
    {
        char const* enabled = std::getenv("REALM_BRIDGE_TEST_ENABLE");
        if (!enabled || std::string(enabled) != "1" || !sWorld.IsRealmBridgeQuiescent() || !sObjectAccessor.GetPlayers().empty())
        { PSendSysMessage("REALM_BRIDGE_V1 %s", RealmBridge::Result(request, "waiting").c_str()); return true; }
#if defined(ENABLE_PLAYERBOTS) || defined(BUILD_AHBOT)
        PSendSysMessage("REALM_BRIDGE_V1 %s", RealmBridge::Result(request, "closed").c_str()); return true;
#endif
    }
    auto completion = std::make_shared<RealmBridge::Completion>();
    auto result = completion->promise.get_future();
    auto operation = new RealmBridge::Operation(request, completion);
    if (!CharacterDatabase.QueueWorldBridge(operation)) { delete operation; return false; }
    // Do not resume world updates, sessions or callbacks before a checked result.
    // A caller's SOAP timeout must NEVER cancel or destroy this operation.
    std::string output = result.get();
    PSendSysMessage("REALM_BRIDGE_V1 %s", output.c_str());
    if (!completion->known) World::StopNow(ERROR_EXIT_CODE);
    return true;
}
`;
const changes = {
  "src/mangosd/MaNGOSsoap.cpp": (text) =>
    replace(
      replace(
        replace(
          replace(
            text,
            "#include <string>",
            "#include <string>\n#include <atomic>",
          ),
          "    bool commandExecuted = false, commandSucceeded = false;",
          "    std::atomic<bool> commandExecuted{false};\n    bool commandSucceeded = false;",
        ),
        "        commandExecuted = true;\n        commandSucceeded = success;",
        "        commandSucceeded = success;\n        commandExecuted.store(true, std::memory_order_release);",
      ),
      "    while (!commandExecuted)",
      "    while (!commandExecuted.load(std::memory_order_acquire))",
    ),
  "src/shared/Database/Database.h": (text) =>
    replace(
      replace(
        text,
        "        virtual bool BeginTransaction() { return true; }",
        "        virtual bool ConfigureWorldBridgeConnection() { return false; }\n        virtual bool BeginTransaction() { return true; }",
      ),
      "        bool CommitTransactionDirect();",
      "        bool CommitTransactionDirect();\n        bool QueueWorldBridge(SqlOperation* operation);\n        bool HasQueuedExecutionFailure() const;",
    ),
  "src/shared/Database/Database.cpp": (text) =>
    text +
    `\n// Ownership transfers only when the existing single-writer FIFO accepts the job.\nbool Database::QueueWorldBridge(SqlOperation* operation)\n{\n    if (!operation || !m_allowAsyncTransactions || !m_threadBody || m_currentTransaction.get()) return false;\n    return m_threadBody->Delay(operation);\n}\nbool Database::HasQueuedExecutionFailure() const\n{\n    return !m_threadBody || m_threadBody->HasExecutionFailure();\n}\n`,
  "src/shared/Database/DatabaseMysql.h": (text) =>
    replace(
      text,
      "        bool BeginTransaction() override;",
      "        bool ConfigureWorldBridgeConnection() override\n        {\n            bool reconnect = false;\n            return mMysql && mysql_options(mMysql, MYSQL_OPT_RECONNECT, &reconnect) == 0;\n        }\n        bool BeginTransaction() override;",
    ),
  "src/shared/Database/SqlDelayThread.h": (text) =>
    replace(
      replace(
        text,
        "        std::atomic<bool> m_running;",
        "        std::atomic<bool> m_running;\n        std::atomic<bool> m_executionFailed{false};",
      ),
      "        virtual void Stop();",
      "        bool HasExecutionFailure() const { return m_executionFailed.load(); }\n        virtual void Stop();",
    ),
  "src/shared/Database/SqlDelayThread.cpp": (text) =>
    replace(
      text,
      "        s->Execute(m_dbConnection);",
      "        if (!s->Execute(m_dbConnection)) m_executionFailed = true;",
    ),
  "src/game/Chat/Chat.h": (text) =>
    replace(
      text,
      "        bool HandleAccountCommand(char* args);",
      "        bool HandleRealmBridgeCommand(char* args);\n        bool HandleAccountCommand(char* args);",
    ),
  "src/game/Chat/Chat.cpp": (text) =>
    replace(
      text,
      "    static ChatCommand commandTable[] =\n    {",
      '    static ChatCommand commandTable[] =\n    {\n        { "realmbridge", SEC_CONSOLE, true, &ChatHandler::HandleRealmBridgeCommand, "", nullptr },',
    ),
  "src/game/Chat/Level3.cpp": (text) =>
    replace(
      text,
      '#include "Common.h"',
      '#include "Common.h"\n#include "Database/WorldBridge.h"',
    ) + handler,
  "src/game/World/World.h": (text) =>
    replace(
      text,
      "        void AddSession(WorldSession* s);",
      "        void AddSession(WorldSession* s);\n        bool IsRealmBridgeQuiescent()\n        {\n            std::lock_guard<std::mutex> lock(m_sessionAddQueueLock);\n            return m_sessions.empty() && m_QueuedSessions.empty() && m_sessionAddQueue.empty();\n        }",
    ),
  "src/game/World/World.cpp": (text) =>
    replace(
      replace(
        text,
        '#include "World/World.h"',
        '#include "World/World.h"\n#include "Database/WorldBridge.h"',
      ),
      "World::AddSession_(WorldSession* s)\n{\n    MANGOS_ASSERT(s);",
      "World::AddSession_(WorldSession* s)\n{\n    MANGOS_ASSERT(s);\n    if (!RealmBridge::LoginPermitted()) { s->KickPlayer(); delete s; return; }",
    ),
};
let patch = "";
for (const file of files) {
  const original = join(before, file);
  mkdirSync(dirname(original), { recursive: true });
  if (!existsSync(original)) {
    const response = await fetch(
      `https://raw.githubusercontent.com/cmangos/mangos-classic/${revision}/${file}`,
      { signal: AbortSignal.timeout(30000) },
    );
    if (!response.ok) throw new Error("Cannot read pinned " + file);
    writeFileSync(original, (await response.text()).replaceAll("\r\n", "\n"));
  }
  const text = readFileSync(original, "utf8");
  manifest.files[file] = sha(text);
  const changed = changes[file](text);
  const output = join(after, file);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, changed);
  const diff = spawnSync(
    "git",
    ["diff", "--no-index", "--no-prefix", "--", original, output],
    { encoding: "utf8" },
  );
  if (![0, 1].includes(diff.status)) throw new Error(diff.stderr);
  patch += diff.stdout
    .split("\n")
    .map((line) =>
      line.startsWith("diff --git ")
        ? `diff --git a/${file} b/${file}`
        : line.startsWith("--- ")
          ? `--- a/${file}`
          : line.startsWith("+++ ")
            ? `+++ b/${file}`
            : line,
    )
    .join("\n");
}
const header = readFileSync(
    join(here, "core/WorldBridge.h"),
    "utf8",
  ).replaceAll("\r\n", "\n"),
  headerPath = "src/shared/Database/WorldBridge.h";
const lines = header.trimEnd().split("\n");
patch += `diff --git a/${headerPath} b/${headerPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${headerPath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => "+" + line).join("\n")}\n`;
writeFileSync(join(here, "core/world-bridge.patch"), patch);
writeFileSync(
  join(here, "core/pinned-sources.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
const check = spawnSync(
  "git",
  ["apply", "--check", "--unsafe-paths", join(here, "core/world-bridge.patch")],
  { cwd: before, encoding: "utf8" },
);
if (check.status !== 0) throw new Error(check.stderr);
console.log(
  "Pinned patch applies cleanly to " +
    revision +
    "; compilation not performed.",
);

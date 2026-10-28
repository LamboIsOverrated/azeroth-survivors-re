// Compiles the actual ChatHandler body extracted from the generated source carry.
#include "WorldBridge.h"
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <iostream>

FakeDatabase CharacterDatabase;
bool FakeDatabase::QueueWorldBridge(SqlOperation*) { return false; }
struct PrivateWorld { bool IsRealmBridgeQuiescent() const { return false; } } sWorld;
struct PrivateObjects { std::vector<int> GetPlayers() const { return {1}; } } sObjectAccessor;
struct World { static bool stopped; static void StopNow(int) { stopped = true; } };
bool World::stopped = false;
constexpr int ERROR_EXIT_CODE = 1;
class ChatHandler
{
public:
    bool inGame = false;
    std::string output;
    bool GetSession() const { return inGame; }
    void PSendSysMessage(char const* format, char const* data)
    {
        char buffer[1024];
        int size = std::snprintf(buffer, sizeof(buffer), format, data);
        assert(size > 0 && static_cast<size_t>(size) < sizeof(buffer));
        output = buffer;
    }
    bool HandleRealmBridgeCommand(char*);
};
#include "realm-bridge-handler.inc"

struct Connection final : SqlConnection
{
    std::string count = "0";
    bool available = true, failDuringRead = false;
    unsigned reads = 0, mutations = 0;
    bool ConfigureWorldBridgeConnection() override { ++mutations; return true; }
    bool BeginTransaction() override { ++mutations; return true; }
    bool CommitTransaction() override { ++mutations; return true; }
    bool RollbackTransaction() override { ++mutations; return true; }
    bool Execute(char const*) override { ++mutations; return false; }
    std::unique_ptr<QueryResult> Query(char const* sql) override
    {
        ++reads;
        assert(std::string(sql) == "SELECT COUNT(*) FROM realm_bridge_inflight");
        if (failDuringRead) CharacterDatabase.failed = true;
        if (!available) return nullptr;
        auto row = std::make_unique<QueryResult>(); row->fields.push_back({count}); return row;
    }
};
bool Handle(ChatHandler& handler, std::string input)
{
    return handler.HandleRealmBridgeCommand(input.data());
}
int main()
{
#ifdef _WIN32
    _putenv_s("REALM_BRIDGE_TEST_ENABLE", "0");
#else
    setenv("REALM_BRIDGE_TEST_ENABLE", "0", 1);
#endif
    Connection connection; CharacterDatabase.connection = &connection;
    ChatHandler handler;
    assert(Handle(handler, "v1 health"));
    assert(handler.output == "REALM_BRIDGE_HEALTH_V1 {\"version\":1,\"loginPermitted\":true,\"writerFailed\":false,\"inflightQueryOk\":true,\"inflight\":\"0\",\"reason\":\"ready\"}");
    assert(connection.mutations == 0 && !World::stopped && !CharacterDatabase.failed);

    handler.inGame = true; handler.output.clear(); unsigned before = connection.reads;
    assert(!Handle(handler, "v1 health") && handler.output.empty() && connection.reads == before);
    handler.inGame = false;
    for (auto input : {"health", "v2 health", "v1 health extra", "v1 health ", "v1  health", "v1 TEST health", "v1 LIVE health", " v1 health"})
    {
        handler.output.clear(); before = connection.reads;
        assert(!Handle(handler, input) && handler.output.empty() && connection.reads == before);
    }
    before = connection.reads;
    assert(Handle(handler, "v1 TEST apply " + std::string(64, 'a') + " grant 1 7 70 50"));
    assert(handler.output.find("REALM_BRIDGE_V1 ") == 0 && handler.output.find("\"state\":\"waiting\"") != std::string::npos);
    assert(connection.reads == before && connection.mutations == 0 && !World::stopped);

    CharacterDatabase.failed = true; before = connection.reads;
    assert(Handle(handler, "v1 health"));
    assert(handler.output == "REALM_BRIDGE_HEALTH_V1 {\"version\":1,\"loginPermitted\":false,\"writerFailed\":true,\"inflightQueryOk\":false,\"inflight\":null,\"reason\":\"writer-failed\"}");
    assert(CharacterDatabase.failed && connection.reads == before);
    CharacterDatabase.failed = false;

    connection.available = false;
    assert(Handle(handler, "v1 health"));
    assert(handler.output == "REALM_BRIDGE_HEALTH_V1 {\"version\":1,\"loginPermitted\":false,\"writerFailed\":false,\"inflightQueryOk\":false,\"inflight\":null,\"reason\":\"inflight-query-failed\"}");
    connection.available = true;
    connection.count = "1";
    assert(Handle(handler, "v1 health"));
    assert(handler.output == "REALM_BRIDGE_HEALTH_V1 {\"version\":1,\"loginPermitted\":false,\"writerFailed\":false,\"inflightQueryOk\":true,\"inflight\":\"1\",\"reason\":\"inflight-pending\"}");
    assert(connection.count == "1");
    connection.count = "0garbage";
    assert(Handle(handler, "v1 health"));
    assert(handler.output.find("\"inflightQueryOk\":false,\"inflight\":null") != std::string::npos);

    connection.count = "0"; connection.failDuringRead = true;
    assert(Handle(handler, "v1 health"));
    assert(handler.output == "REALM_BRIDGE_HEALTH_V1 {\"version\":1,\"loginPermitted\":false,\"writerFailed\":true,\"inflightQueryOk\":true,\"inflight\":\"0\",\"reason\":\"writer-failed\"}");
    assert(CharacterDatabase.failed && connection.mutations == 0 && !World::stopped);
    std::cout << "Actual generated health handler: console-only, TEST0/online read-only, strict grammar and failed/fenced gates passed\n";
}

// Realm bridge carry for CMaNGOS de8f72993b9e1faa1bf92dd5505f3daec5cea3ce.
// GPL-2.0-or-later, consistent with the hosting CMaNGOS source.
#ifndef REALM_WORLD_BRIDGE_H
#define REALM_WORLD_BRIDGE_H
#include "Database/DatabaseEnv.h"
#include "Database/SqlOperations.h"
#include <cstdlib>
#include <future>
#include <sstream>
#include <memory>
#include <array>

namespace RealmBridge
{
struct Request
{
    std::string action, id, direction, account, guid, units, expected;
    std::string Payload() const { return "v1 TEST " + id + " " + direction + " " + account + " " + guid + " " + units + " " + expected; }
};
inline bool Decimal(std::string const& text, uint64 cap, bool zero = false)
{
    if (text.empty() || text.size() > 10 || (text.size() > 1 && text[0] == '0')) return false;
    uint64 result = 0;
    for (char c : text) { if (c < '0' || c > '9') return false; result = result * 10 + uint64(c - '0'); if (result > cap) return false; }
    return zero || result != 0;
}
inline bool Parse(char const* args, Request& r)
{
    std::istringstream input(args ? args : ""); std::string version, phase, extra;
    if (!(input >> version >> phase >> r.action >> r.id >> r.direction >> r.account >> r.guid >> r.units >> r.expected) || (input >> extra)) return false;
    if (version != "v1" || phase != "TEST" || (r.action != "apply" && r.action != "status") || (r.direction != "grant" && r.direction != "debit") || r.id.size() != 64) return false;
    for (char c : r.id) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    return Decimal(r.account, 4294967295ULL) && Decimal(r.guid, 4294967295ULL) && Decimal(r.units, 2147483646ULL) && Decimal(r.expected, 2147483646ULL, true);
}
inline std::string Result(Request const& r, std::string const& state, std::string before = "0", std::string after = "0", std::string reason = "")
{
    return "{\"version\":1,\"phase\":\"TEST\",\"id\":\"" + r.id + "\",\"direction\":\"" + r.direction + "\",\"accountId\":\"" + r.account + "\",\"guid\":\"" + r.guid + "\",\"units\":\"" + r.units + "\",\"expectedBefore\":\"" + r.expected + "\",\"state\":\"" + state + "\",\"before\":\"" + before + "\",\"after\":\"" + after + "\",\"reason\":\"" + reason + "\"}";
}
// Always fail closed on a missing schema or unresolved operation, even if the TEST
// command is disabled. This gate is installed before a new WorldSession is loaded.
inline bool LoginPermitted()
{
    if (CharacterDatabase.HasQueuedExecutionFailure()) return false;
    auto result = CharacterDatabase.Query("SELECT COUNT(*) FROM realm_bridge_inflight");
    return result && (*result)[0].GetUInt64() == 0;
}
struct Completion { std::promise<std::string> promise; bool known = false; };
class Operation final : public SqlOperation
{
    Request request;
    std::shared_ptr<Completion> completion;
    bool transaction = false;
    bool FinishFence(SqlConnection* conn)
    {
        return conn->Execute(("DELETE FROM realm_bridge_inflight WHERE operation_id='" + request.id + "' AND payload='" + request.Payload() + "'").c_str());
    }
    std::string Run(SqlConnection* conn)
    {
        Request const& r = request;
        // This operation reaches the same FIFO writer connection AFTER older saves.
        // Do not trust CommitTransactionDirect's boolean at this pinned revision.
        if (CharacterDatabase.HasQueuedExecutionFailure() || !conn->ConfigureWorldBridgeConnection()) return Result(r, "unknown");
        auto engines = conn->Query("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('characters','realm_bridge_inflight','realm_bridge_receipts') AND ENGINE='InnoDB'");
        if (!engines || (*engines)[0].GetUInt32() != 3) return Result(r, "unknown");
        // Autocommit fence precedes the money transaction. It survives an unknown
        // COMMIT result and blocks all new logins until a locking status read.
        if (!conn->Execute(("INSERT IGNORE INTO realm_bridge_inflight(operation_id,payload) VALUES('" + r.id + "','" + r.Payload() + "')").c_str())) return Result(r, "unknown");
        if (!conn->BeginTransaction()) return Result(r, "unknown");
        transaction = true;
        auto fence = conn->Query(("SELECT payload FROM realm_bridge_inflight WHERE operation_id='" + r.id + "' FOR UPDATE").c_str());
        if (!fence || (*fence)[0].GetCppString() != r.Payload()) return Result(r, "unknown");
        // The row lock above waits for any previous indeterminate transaction.
        // COUNT returns a row on absence; nullptr is ALWAYS an error, never absence.
        auto old = conn->Query(("SELECT COUNT(*),COALESCE(MAX(payload),''),COALESCE(MAX(state),''),COALESCE(MAX(before_money),0),COALESCE(MAX(after_money),0),COALESCE(MAX(reason),'') FROM realm_bridge_receipts WHERE operation_id='" + r.id + "'").c_str());
        if (!old) return Result(r, "unknown");
        if ((*old)[0].GetUInt32() != 0)
        {
            if ((*old)[0].GetUInt32() != 1 || (*old)[1].GetCppString() != r.Payload()) return Result(r, "unknown");
            std::string result = Result(r, (*old)[2].GetCppString(), std::to_string((*old)[3].GetUInt32()), std::to_string((*old)[4].GetUInt32()), (*old)[5].GetCppString());
            if (!conn->RollbackTransaction()) return Result(r, "unknown"); transaction = false;
            if (!FinishFence(conn)) return Result(r, "unknown"); completion->known = true; return result;
        }
        if (r.action == "status")
        {
            if (!conn->RollbackTransaction()) return Result(r, "unknown"); transaction = false;
            if (!FinishFence(conn)) return Result(r, "unknown"); completion->known = true; return Result(r, "absent");
        }
        auto character = conn->Query(("SELECT account,money,online FROM characters WHERE guid=" + r.guid + " FOR UPDATE").c_str());
        if (!character) return Result(r, "unknown");
        uint64 before = (*character)[1].GetUInt32(), after = before, quantity = std::stoull(r.units);
        std::string reason;
        if ((*character)[0].GetUInt32() != std::stoull(r.account)) { reason = "owner"; before = after = 0; }
        else if ((*character)[2].GetUInt32() != 0) reason = "online";
        else if (before != std::stoull(r.expected)) reason = "stale";
        else if (r.direction == "debit" && before < quantity) reason = "balance";
        else if (r.direction == "grant" && before + quantity > 2147483646ULL) reason = "cap";
        else after = r.direction == "grant" ? before + quantity : before - quantity;
        if (reason.empty())
        {
            if (!conn->Execute(("UPDATE characters SET money=" + std::to_string(after) + " WHERE guid=" + r.guid + " AND account=" + r.account + " AND money=" + std::to_string(before) + " AND online=0").c_str())) return Result(r, "unknown");
            auto check = conn->Query(("SELECT account,money,online FROM characters WHERE guid=" + r.guid + " FOR UPDATE").c_str());
            if (!check || (*check)[0].GetUInt32() != std::stoull(r.account) || (*check)[1].GetUInt32() != after || (*check)[2].GetUInt32() != 0) return Result(r, "unknown");
        }
        std::string state = reason.empty() ? "applied" : "rejected";
        if (!conn->Execute(("INSERT INTO realm_bridge_receipts(operation_id,payload,state,before_money,after_money,reason) VALUES('" + r.id + "','" + r.Payload() + "','" + state + "'," + std::to_string(before) + "," + std::to_string(after) + ",'" + reason + "')").c_str())) return Result(r, "unknown");
        if (!conn->CommitTransaction()) return Result(r, "unknown"); transaction = false;
        if (!FinishFence(conn)) return Result(r, "unknown");
        completion->known = true; return Result(r, state, std::to_string(before), std::to_string(after), reason);
    }
public:
    Operation(Request r, std::shared_ptr<Completion> c) : request(std::move(r)), completion(std::move(c)) {}
    bool Execute(SqlConnection* conn) override
    {
        SqlConnection::Lock lock(conn);
        std::string result = Result(request, "unknown");
        try { result = Run(conn); } catch (...) { completion->known = false; }
        if (transaction) { conn->RollbackTransaction(); transaction = false; }
        bool known = completion->known;
        completion->promise.set_value(result); // shared ownership outlives SOAP/client timeout
        return known;
    }
};
}
#endif

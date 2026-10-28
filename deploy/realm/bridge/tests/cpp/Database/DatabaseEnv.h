#pragma once
#include <cstdint>
#include <string>
#include <memory>
#include <vector>
#include <mutex>
using uint64 = uint64_t;
using uint32 = uint32_t;
struct Field { std::string value; uint64 GetUInt64() const { return std::stoull(value); } uint32 GetUInt32() const { return uint32(GetUInt64()); } std::string GetCppString() const { return value; } };
struct QueryResult { std::vector<Field> fields; Field const& operator[](size_t i) const { return fields.at(i); } };
class SqlConnection {
public:
 std::recursive_mutex mutex;
 class Lock { std::lock_guard<std::recursive_mutex> lock; public: explicit Lock(SqlConnection* c):lock(c->mutex){} };
 virtual ~SqlConnection() = default;
 virtual bool ConfigureWorldBridgeConnection() = 0;
 virtual bool BeginTransaction() = 0;
 virtual bool CommitTransaction() = 0;
 virtual bool RollbackTransaction() = 0;
 virtual bool Execute(char const*) = 0;
 virtual std::unique_ptr<QueryResult> Query(char const*) = 0;
};
struct FakeDatabase {
 SqlConnection* connection = nullptr;
 bool failed = false;
 bool HasQueuedExecutionFailure() const { return failed; }
 std::unique_ptr<QueryResult> Query(char const* sql) { return connection->Query(sql); }
};
extern FakeDatabase CharacterDatabase;

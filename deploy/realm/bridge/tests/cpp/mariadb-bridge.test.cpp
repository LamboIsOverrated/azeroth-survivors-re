// Real InnoDB fault drill for the exact WorldBridge.h kernel. The small test
// adapter matches SqlConnection's null-on-empty/error contract; it is not the
// complete CMaNGOS world/session/FIFO integration acceptance.
#include "WorldBridge.h"
#include <mysql.h>
#include <chrono>
#include <fstream>
#include <functional>
#include <iostream>
#include <thread>
#include <regex>

FakeDatabase CharacterDatabase;
void Require(bool condition, std::string const& message) { if (!condition) throw std::runtime_error(message); }
std::string Env(char const* name) { char const* value=std::getenv(name); return value ? value : ""; }
struct Adapter final : SqlConnection
{
    MYSQL* connection = nullptr;
    bool loseCommitReply = false;
    std::string failStatement;
    std::function<void()> beforeCommit;
    std::function<void()> beforeFenceInsert;
    explicit Adapter(std::string const& database)
    {
        connection=mysql_init(nullptr); Require(connection != nullptr,"mysql_init failed");
        bool reconnect=false; mysql_options(connection,MYSQL_OPT_RECONNECT,&reconnect);
        unsigned int timeout=5; mysql_options(connection,MYSQL_OPT_CONNECT_TIMEOUT,&timeout);
        mysql_options(connection,MYSQL_OPT_READ_TIMEOUT,&timeout);mysql_options(connection,MYSQL_OPT_WRITE_TIMEOUT,&timeout);
        if (!mysql_real_connect(connection,"127.0.0.1","root",Env("BRIDGE_CI_DB_PASSWORD").c_str(),database.empty()?nullptr:database.c_str(),3306,nullptr,0))
        { std::string error=mysql_error(connection);mysql_close(connection);connection=nullptr;throw std::runtime_error("Scratch connection failed: "+error); }
    }
    ~Adapter() override { if(connection)mysql_close(connection); }
    bool ConfigureWorldBridgeConnection() override { bool reconnect=false;return mysql_options(connection,MYSQL_OPT_RECONNECT,&reconnect)==0; }
    bool Raw(std::string const& sql) { return mysql_query(connection,sql.c_str())==0; }
    bool BeginTransaction() override { return Raw("START TRANSACTION"); }
    bool CommitTransaction() override
    {
        if(beforeCommit){auto hook=std::move(beforeCommit);beforeCommit={};hook();}
        bool committed=Raw("COMMIT");return committed&&!loseCommitReply;
    }
    bool RollbackTransaction() override { return Raw("ROLLBACK"); }
    bool Execute(char const* sql) override
    {
        if(beforeFenceInsert&&std::string(sql).find("INSERT IGNORE INTO realm_bridge_inflight")==0)
        { auto hook=std::move(beforeFenceInsert);beforeFenceInsert={};hook(); }
        if(!failStatement.empty()&&std::string(sql).find(failStatement)==0)
            return Raw("INSERT INTO realm_bridge_receipts(no_such_column) VALUES(1)");
        return Raw(sql);
    }
    std::unique_ptr<QueryResult> Query(char const* sql) override
    {
        if(!failStatement.empty()&&std::string(sql).find(failStatement)==0)
        { Raw("SELECT no_such_column FROM characters");return nullptr; }
        if(!Raw(sql))return nullptr;
        MYSQL_RES* raw=mysql_store_result(connection);if(!raw)return nullptr;
        MYSQL_ROW row=mysql_fetch_row(raw);if(!row){mysql_free_result(raw);return nullptr;}
        auto result=std::make_unique<QueryResult>();
        for(unsigned int i=0;i<mysql_num_fields(raw);++i)result->fields.push_back({row[i]?row[i]:""});
        mysql_free_result(raw);return result;
    }
    std::string Scalar(std::string const& sql) { auto result=Query(sql.c_str());Require(bool(result),"Scratch verification query failed");return (*result)[0].GetCppString(); }
};
RealmBridge::Request Request(std::string action="apply",std::string direction="grant")
{
    RealmBridge::Request request;Require(RealmBridge::Parse(("v1 TEST "+action+" "+std::string(64,'a')+" "+direction+" 1 7 70 50").c_str(),request),"Bad fixture request");return request;
}
std::pair<bool,std::string> Run(Adapter& connection,RealmBridge::Request request=Request())
{
    CharacterDatabase.connection=&connection;CharacterDatabase.failed=false;
    auto completion=std::make_shared<RealmBridge::Completion>();auto future=completion->promise.get_future();
    RealmBridge::Operation operation(request,completion);bool known=operation.Execute(&connection);return {known,future.get()};
}
void Reset(Adapter& observer)
{
    for(auto const& sql:{"DELETE FROM realm_bridge_inflight","DELETE FROM realm_bridge_receipts","DELETE FROM characters","INSERT INTO characters(guid,account,money,online) VALUES(7,1,50,0)"})
        Require(observer.Raw(sql),"Scratch reset failed");
}
void Verify(Adapter& observer,std::string money,std::string receipts,std::string fences)
{
    Require(observer.Scalar("SELECT money FROM characters WHERE guid=7")==money,"Unexpected persisted character money");
    Require(observer.Scalar("SELECT COUNT(*) FROM realm_bridge_receipts")==receipts,"Unexpected durable receipt count");
    Require(observer.Scalar("SELECT COUNT(*) FROM realm_bridge_inflight")==fences,"Unexpected durable login fence count");
}
void Drill(std::string const& database)
{
    Adapter observer(database);
    Require(observer.Raw("CREATE TABLE characters(guid INT UNSIGNED PRIMARY KEY,account INT UNSIGNED NOT NULL,money INT UNSIGNED NOT NULL,online TINYINT UNSIGNED NOT NULL) ENGINE=InnoDB"),"Scratch characters schema failed");
    std::ifstream schema(Env("BRIDGE_CI_SCHEMA"));Require(bool(schema),"TEST schema file is required");std::string line,sql;
    while(std::getline(schema,line)){if(line.find("--")==0)continue;sql+=line+'\n';}
    Require(sql.size()<20000,"Unexpected schema size");size_t offset=0;
    for(;;)
    { auto end=sql.find(';',offset);if(end==std::string::npos)break;Require(observer.Raw(sql.substr(offset,end-offset)),"Scratch bridge schema failed");offset=end+1; }
    Reset(observer);
    {Adapter writer(database);Require(Run(writer).first,"Grant did not commit");Require(Run(writer).first,"Replay failed");Verify(observer,"120","1","0");}
    std::cout<<"PASS actual MariaDB commit, separate-connection read and idempotent replay\n";
    for(auto const& failure:{"UPDATE characters","INSERT INTO realm_bridge_receipts","SELECT COUNT(*),COALESCE(MAX(account)"})
    {
        Reset(observer);Adapter writer(database);writer.failStatement=failure;Require(!Run(writer).first,"SQL error was falsely acknowledged");Verify(observer,"50","0","1");
        CharacterDatabase.connection=&observer;Require(!RealmBridge::LoginPermitted(),"Unknown SQL error lost its login fence");
        Adapter restart(database);Require(Run(restart,Request("status")).first,"Locking absence reconciliation failed");Verify(observer,"50","0","0");
    }
    std::cout<<"PASS real query/update/receipt SQL errors roll back money and retain fence until checked absence\n";
    Reset(observer);
    {Adapter writer(database);writer.loseCommitReply=true;Require(!Run(writer).first,"Lost commit reply was falsely acknowledged");Verify(observer,"120","1","1");}
    {Adapter restart(database);auto result=Run(restart,Request("status"));Require(result.first&&result.second.find("\"applied\"")!=std::string::npos,"Committed receipt was not recovered after reconnect");Require(Run(restart).first,"Committed operation replay failed");Verify(observer,"120","1","0");}
    std::cout<<"PASS committed transaction with lost acknowledgement survives reconnect without second credit\n";
    Reset(observer);
    {Adapter writer(database);auto id=writer.Scalar("SELECT CONNECTION_ID()");writer.beforeCommit=[&observer,id]{Require(observer.Raw("KILL CONNECTION "+id),"Fault injection failed to kill scratch connection");};Require(!Run(writer).first,"Killed connection was falsely acknowledged");}
    {Adapter restart(database);auto result=Run(restart,Request("status"));Require(result.first&&result.second.find("\"absent\"")!=std::string::npos,"Killed precommit operation was not proven absent");Verify(observer,"50","0","0");Require(Run(restart).first,"Safe retry after killed connection failed");Verify(observer,"120","1","0");}
    std::cout<<"PASS real server KILL before COMMIT rolls back and locking status permits one safe retry\n";
    Reset(observer);
    {Adapter writer(database);Require(observer.Raw("DELETE FROM characters WHERE guid=7"),"Fixture deletion failed");auto result=Run(writer);Require(result.first&&observer.Scalar("SELECT reason FROM realm_bridge_receipts")=="missing-character","Missing character was not durably rejected");Require(observer.Scalar("SELECT COUNT(*) FROM realm_bridge_inflight")=="0","Deleted character retained login fence");Require(Run(writer).first,"Missing-character rejection replay failed");}
    std::cout<<"PASS deleted character yields a durable full-length rejection and no permanent login fence\n";
    Reset(observer);
    {
        Adapter writer(database);auto request=Request();
        Require(writer.Raw("INSERT INTO realm_bridge_inflight(operation_id,payload) VALUES('"+request.id+"','"+request.Payload()+"')"),"Barrier fence failed");
        Require(writer.BeginTransaction(),"Barrier transaction failed");Require(bool(writer.Query(("SELECT payload FROM realm_bridge_inflight WHERE operation_id='"+request.id+"' FOR UPDATE").c_str())),"Barrier row lock failed");
        Require(writer.Raw("UPDATE characters SET money=120 WHERE guid=7"),"Barrier money update failed");
        Require(writer.Raw("INSERT INTO realm_bridge_receipts(operation_id,payload,state,before_money,after_money,reason) VALUES('"+request.id+"','"+request.Payload()+"','applied',50,120,'')"),"Barrier receipt failed");
        std::promise<void> started;auto startedFuture=started.get_future();
        auto status=std::async(std::launch::async,[&database,&started]{mysql_thread_init();std::pair<bool,std::string> result;{Adapter reader(database);reader.beforeFenceInsert=[&started]{started.set_value();};result=Run(reader,Request("status"));}mysql_thread_end();return result;});
        bool startedReady=startedFuture.wait_for(std::chrono::seconds(5))==std::future_status::ready;
        bool waited=startedReady&&status.wait_for(std::chrono::milliseconds(150))==std::future_status::timeout;
        bool committed=writer.CommitTransaction();auto result=status.get();
        Require(waited&&committed&&result.first&&result.second.find("\"applied\"")!=std::string::npos,"Status crossed the in-flight commit barrier");Verify(observer,"120","1","0");
    }
    std::cout<<"PASS concurrent real status lookup waits for the InnoDB fence lock and observes committed receipt\n";
}
int main()
{
    std::string database=Env("BRIDGE_CI_DATABASE");
    if(Env("BRIDGE_CI_SCRATCH")!="1"||Env("BRIDGE_CI_DB_PASSWORD").empty()||!std::regex_match(database,std::regex("realm_bridge_ci_[a-z0-9_]{1,30}")))
    {std::cerr<<"Refusing SQL: explicit fresh CI-only database configuration required\n";return 2;}
    mysql_library_init(0,nullptr,nullptr);int result=0;
    try
    {
        Adapter admin("");Require(admin.Raw("CREATE DATABASE "+database),"Scratch database must be new; existing database is never reused");
        try {Drill(database);}catch(...){Require(admin.Raw("DROP DATABASE "+database),"Owned scratch cleanup failed");throw;}
        Require(admin.Raw("DROP DATABASE "+database),"Owned scratch cleanup failed");
    }
    catch(std::exception const& error){std::cerr<<"MariaDB scratch drill failed: "<<error.what()<<"\n";result=1;}
    mysql_library_end();return result;
}

#include "WorldBridge.h"
#include <cassert>
#include <optional>
#include <regex>
#include <iostream>
FakeDatabase CharacterDatabase;
struct Receipt { std::string payload, state, before, after, reason; };
struct Connection : SqlConnection {
 uint64 money = 50, owner = 1, online = 0, oldMoney = 0;
 bool inTransaction = false, configure = true, schema = true, loseCommitAck = false, commitApplied = true;
 bool missingCharacter = false, characterQueryError = false, reasonColumnWide = true;
 std::optional<std::string> inflightCount;
 unsigned countFields = 1, countRows = 1, countQueries = 0, executions = 0, transactions = 0;
 bool failWriterDuringCountRead = false, throwDuringCountRead = false;
 std::string failPrefix;
 std::optional<std::string> fence;
 std::optional<Receipt> receipt, oldReceipt;
 bool ConfigureWorldBridgeConnection() override { return configure; }
 bool BeginTransaction() override { ++transactions; assert(!inTransaction); inTransaction=true; oldMoney=money; oldReceipt=receipt; return true; }
 bool CommitTransaction() override { assert(inTransaction); if(commitApplied)inTransaction=false; return !loseCommitAck; }
 bool RollbackTransaction() override { if(inTransaction){money=oldMoney;receipt=oldReceipt;inTransaction=false;}return true; }
 std::unique_ptr<QueryResult> Row(std::vector<std::string> const& values) { auto result=std::make_unique<QueryResult>();for(auto const& value:values)result->fields.push_back({value});return result; }
 std::unique_ptr<QueryResult> Query(char const* sql) override {
  std::string s(sql);
  if(s.find("information_schema.TABLES")!=std::string::npos)return Row({schema?"3":"0"});
  if(s.find("information_schema.COLUMNS")!=std::string::npos)return Row({reasonColumnWide?"1":"0"});
  if(s=="SELECT COUNT(*) FROM realm_bridge_inflight") {
   ++countQueries;
   if(throwDuringCountRead)throw std::runtime_error("count read failed");
   if(failWriterDuringCountRead)CharacterDatabase.failed=true;
   if(!schema)return nullptr;
   auto result=Row({inflightCount?*inflightCount:(fence?"1":"0")});
   result->fields.resize(countFields);result->rowCount=countRows;return result;
  }
  if(s.find("SELECT payload FROM realm_bridge_inflight")==0)return fence?Row({*fence}):nullptr;
  if(s.find("FROM realm_bridge_receipts")!=std::string::npos)return receipt?Row({"1",receipt->payload,receipt->state,receipt->before,receipt->after,receipt->reason}):Row({"0","","","0","0",""});
  if(s.find("SELECT COUNT(*),COALESCE(MAX(account)")==0)return characterQueryError?nullptr:missingCharacter?Row({"0","0","0","0"}):Row({"1",std::to_string(owner),std::to_string(money),std::to_string(online)});
  if(s.find("SELECT account,money,online FROM characters")==0)return (missingCharacter||characterQueryError)?nullptr:Row({std::to_string(owner),std::to_string(money),std::to_string(online)});
  assert(false);return nullptr;
 }
 bool Execute(char const* sql) override {
  ++executions;std::string s(sql);if(!failPrefix.empty()&&s.find(failPrefix)==0)return false;
  std::smatch match;
  if(s.find("INSERT IGNORE INTO realm_bridge_inflight")==0){assert(std::regex_search(s,match,std::regex("VALUES\\('[a-f0-9]{64}','([^']+)'\\)")));if(!fence)fence=match[1].str();return true;}
  if(s.find("DELETE FROM realm_bridge_inflight")==0){assert(!inTransaction);fence.reset();return true;}
  if(s.find("UPDATE characters SET money=")==0){assert(inTransaction);assert(std::regex_search(s,match,std::regex("money=([0-9]+)")));money=std::stoull(match[1].str());return true;}
  if(s.find("INSERT INTO realm_bridge_receipts")==0){assert(inTransaction);assert(std::regex_search(s,match,std::regex("VALUES\\('[a-f0-9]{64}','([^']+)','([^']+)',([0-9]+),([0-9]+),'([^']*)'\\)")));receipt=Receipt{match[1].str(),match[2].str(),match[3].str(),match[4].str(),match[5].str()};return true;}
  assert(false);return false;
 }
};
RealmBridge::Request Request(std::string action="apply") {
 RealmBridge::Request request;assert(RealmBridge::Parse(("v1 TEST "+action+" "+std::string(64,'a')+" grant 1 7 70 50").c_str(),request));return request;
}
std::pair<bool,std::string> Run(Connection& conn,RealmBridge::Request request=Request()) {
 CharacterDatabase.connection=&conn;auto completion=std::make_shared<RealmBridge::Completion>();auto future=completion->promise.get_future();RealmBridge::Operation operation(request,completion);bool result=operation.Execute(&conn);return {result,future.get()};
}
int main() {
 RealmBridge::Request invalid;assert(!RealmBridge::Parse("v1 LIVE apply a grant 1 7 1 0",invalid));assert(!RealmBridge::Parse(("v1 TEST apply "+std::string(64,'a')+" grant 1 7 01 50").c_str(),invalid));
 {Connection c;auto applied=Run(c);assert(applied.first&&c.money==120&&!c.fence&&c.receipt);auto duplicate=Run(c);assert(duplicate.first&&c.money==120);assert(RealmBridge::LoginPermitted());}
 for(auto failure:{"UPDATE characters","INSERT INTO realm_bridge_receipts"}){Connection c;c.failPrefix=failure;assert(!Run(c).first);assert(c.money==50&&!c.receipt&&c.fence);assert(!RealmBridge::LoginPermitted());c.failPrefix="";auto absent=Run(c,Request("status"));assert(absent.first&&absent.second.find("\"absent\"")!=std::string::npos&&!c.fence);}
 {Connection c;c.loseCommitAck=true;c.commitApplied=true;assert(!Run(c).first);assert(c.money==120&&c.receipt&&c.fence);assert(!RealmBridge::LoginPermitted());c.loseCommitAck=false;auto confirmed=Run(c,Request("status"));assert(confirmed.first&&confirmed.second.find("\"applied\"")!=std::string::npos&&c.money==120&&!c.fence);}
 {Connection c;c.loseCommitAck=true;c.commitApplied=false;assert(!Run(c).first);assert(c.money==50&&!c.receipt&&c.fence);c.loseCommitAck=false;c.commitApplied=true;assert(Run(c,Request("status")).first);assert(!c.fence);assert(Run(c).first&&c.money==120);}
 for(auto reason:{"owner","stale","online","cap"}){Connection c;if(std::string(reason)=="owner")c.owner=2;if(std::string(reason)=="stale")c.money=51;if(std::string(reason)=="online")c.online=1;auto request=Request();if(std::string(reason)=="cap"){c.money=2147483640ULL;request.expected="2147483640";}auto before=c.money;auto result=Run(c,request);assert(result.first&&c.money==before&&c.receipt&&c.receipt->state=="rejected"&&c.receipt->reason==reason);}
 {Connection c;c.configure=false;assert(!Run(c).first&&c.money==50&&!c.receipt);}
 {Connection c;CharacterDatabase.failed=true;assert(!Run(c).first&&c.money==50);CharacterDatabase.failed=false;}
 {Connection c;c.schema=false;CharacterDatabase.connection=&c;assert(!RealmBridge::LoginPermitted());assert(!Run(c).first&&c.money==50);}
 for(auto value:{"0garbage","","00","+0","-0"," 0","0 ","0.0","18446744073709551616"}){Connection c;c.inflightCount=value;CharacterDatabase.connection=&c;assert(!RealmBridge::LoginPermitted());auto status=RealmBridge::InspectLoginGate();assert(!status.inflightQueryOk&&status.inflight.empty()&&!status.Permitted()&&std::string(status.Reason())=="inflight-query-failed");}
 for(auto shape:{std::pair<unsigned,unsigned>{0,1},{2,1},{1,0},{1,2}}){Connection c;c.countFields=shape.first;c.countRows=shape.second;CharacterDatabase.connection=&c;auto status=RealmBridge::InspectLoginGate();assert(!status.inflightQueryOk&&status.inflight.empty()&&!status.Permitted()&&!RealmBridge::LoginPermitted());}
 {Connection c;CharacterDatabase.connection=&c;auto status=RealmBridge::InspectLoginGate();assert(status.Permitted()&&RealmBridge::LoginPermitted());assert(status.Json()=="{\"version\":1,\"loginPermitted\":true,\"writerFailed\":false,\"inflightQueryOk\":true,\"inflight\":\"0\",\"reason\":\"ready\"}");assert(c.executions==0&&c.transactions==0&&c.money==50&&!c.fence&&!c.receipt);}
 {Connection c;c.fence=Request().Payload();CharacterDatabase.connection=&c;auto status=RealmBridge::InspectLoginGate();assert(!status.Permitted()&&!RealmBridge::LoginPermitted()&&status.inflight=="1"&&status.inflightQueryOk&&std::string(status.Reason())=="inflight-pending");assert(c.executions==0&&c.transactions==0&&c.money==50&&c.fence==Request().Payload()&&!c.receipt);}
 {Connection c;c.inflightCount="18446744073709551615";CharacterDatabase.connection=&c;auto status=RealmBridge::InspectLoginGate();assert(!status.Permitted()&&status.inflightQueryOk&&status.inflight=="18446744073709551615");}
 {Connection c;CharacterDatabase.connection=&c;CharacterDatabase.failed=true;auto status=RealmBridge::InspectLoginGate();assert(!status.Permitted()&&status.writerFailed&&!status.inflightQueryOk&&status.inflight.empty()&&std::string(status.Reason())=="writer-failed"&&c.countQueries==0);assert(!RealmBridge::LoginPermitted()&&CharacterDatabase.failed);CharacterDatabase.failed=false;}
 {Connection c;c.failWriterDuringCountRead=true;CharacterDatabase.connection=&c;auto status=RealmBridge::InspectLoginGate();assert(!status.Permitted()&&status.writerFailed&&status.inflightQueryOk&&status.inflight=="0"&&std::string(status.Reason())=="writer-failed");assert(!RealmBridge::LoginPermitted()&&CharacterDatabase.failed);CharacterDatabase.failed=false;}
 {Connection c;c.throwDuringCountRead=true;CharacterDatabase.connection=&c;auto status=RealmBridge::InspectLoginGate();assert(!status.Permitted()&&!status.inflightQueryOk&&status.inflight.empty());assert(!RealmBridge::LoginPermitted());}
 assert(RealmBridge::IsHealthCommand("v1 health"));for(auto text:{"","health","v1 TEST health","v1 health extra","v1 health\n"," v1 health","v1  health","v1 health ","v2 health"})assert(!RealmBridge::IsHealthCommand(text));assert(!RealmBridge::IsHealthCommand(nullptr));
 {Connection c;c.missingCharacter=true;auto result=Run(c);assert(result.first&&c.money==50&&!c.fence&&c.receipt&&c.receipt->state=="rejected"&&c.receipt->reason=="missing-character");assert(RealmBridge::LoginPermitted());assert(Run(c).first&&c.money==50);}
 {Connection c;c.characterQueryError=true;assert(!Run(c).first&&c.money==50&&c.fence&&!c.receipt);assert(!RealmBridge::LoginPermitted());}
 {Connection c;c.reasonColumnWide=false;assert(!Run(c).first&&c.money==50&&!c.fence&&!c.receipt);}
 std::cout<<"World bridge kernel: checked transactions, replay, rejection, lost-ack fence and recovery passed\n";
}

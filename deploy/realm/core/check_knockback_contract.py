"""Execute pinned native Send/ACK methods against narrow engine boundary fakes.

The real method bodies and order response map are extracted, not reimplemented.
This proves the wire-to-policy dispatch boundary, not a replacement for full core
compilation and isolated ordinary-client acceptance.
"""
import argparse
from pathlib import Path
import re
import subprocess
import tempfile


def method(source, signature):
    start = source.index(signature)
    opening = source.index('{', start)
    depth, end = 1, opening + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


PRELUDE = r'''
#include "BrowserMovementBudget.h"
#include <cassert>
#include <cstdint>
#include <vector>
#include <utility>
#include <limits>
#include <set>
#include <string>
using uint16=std::uint16_t; using uint32=std::uint32_t; using ObjectGuid=std::uint64_t;
uint32 clockNow=1000;
struct WorldTimer { static uint32 getMSTime() { return clockNow; } };
#define DEBUG_LOG(...) ((void)0)
struct MovementInfo {
    struct Jump { float cosAngle=-1,sinAngle=0,xyspeed=10,zspeed=-10;
        uint32 startClientTime=0; RealmBrowser::Point start{}; } jump;
    uint32 moveFlags=8192; RealmBrowser::Point pos{0,0,10};
    uint32 ctime=1,stime=1000;
    bool HasMovementFlag(uint32 flags)const{return !!(moveFlags&flags);}
    ObjectGuid GetTransportGuid()const{return 0;} RealmBrowser::Point GetTransportPos()const{return {};}
};
constexpr int SEC_PLAYER=0,MOVE_RUN=1,MOVE_SWIM=2,MOVE_WALK=3,
    UNIT_STAT_STUNNED=1,UNIT_STAT_ROOT=2,SPELL_AURA_WATER_WALK=3,SPELL_AURA_GHOST=4,SPELL_AURA_FEATHER_FALL=5,
    MAP_ALL_LIQUIDS=0,LIQUID_MAP_IN_WATER=1,LIQUID_MAP_UNDER_WATER=2,CHEAT_TYPE_TELEPORT=1;
constexpr uint32 MOVEFLAG_ONTRANSPORT=0x02000000, MOVEFLAG_FLYING=0x800,
    MOVEFLAG_CAN_FLY=0x800000,MOVEFLAG_LEVITATING=0x400,MOVEFLAG_JUMPING=8192,
    MOVEFLAG_MASK_MOVING_OR_TURN=0x3f;
namespace MaNGOS { bool IsValidMapCoord(float x,float y,float z,float){return std::isfinite(x)&&std::isfinite(y)&&std::isfinite(z);} }
struct Player;
struct GenericTransport {
    void CalculatePassengerPosition(float&,float&,float&){} void CalculatePassengerOffset(float&,float&,float&){}
    ObjectGuid GetObjectGuid()const{return 9;} std::set<Player*> const& GetPassengers()const {static std::set<Player*> p;return p;}
    bool IsWithinDist(Player*,float,bool)const{return false;}
};
struct Geometry {
    bool wall=false; float floor=10;
    bool IsInLineOfSight(float,float,float,float,float,float,bool)const{return !wall;}
    float GetHeight(float,float,float)const{return floor;}
    bool GetHitPosition(float,float,float,float&,float&,float&,float)const{return false;}
    GenericTransport* GetTransport(ObjectGuid)const{return nullptr;}
    uint32 getLiquidStatus(float,float,float,int,void*)const{return 0;}
    float GetWaterLevel(float,float,float)const{return floor;}
};
struct WorldPacket {
    int opcode; ObjectGuid guid=2; uint32 counter=0; MovementInfo movement;
    WorldPacket(int op, unsigned=0):opcode(op){}
    int GetOpcode() const { return opcode; } unsigned size()const { return 64; }
    unsigned wpos()const { return 64; } void rpos(unsigned){}
    WorldPacket& operator>>(ObjectGuid& out){out=guid;return *this;}
    WorldPacket& operator>>(uint32& out){out=counter;return *this;}
    WorldPacket& operator>>(MovementInfo& out){out=movement;return *this;}
    template<class T> WorldPacket& operator<<(T const&){return *this;}
};
struct Player {
    ObjectGuid guid=2; bool launched=false,teleport=false,selfMover=true; unsigned relays=0;
    RealmBrowser::Point pos{0,0,10}; MovementInfo movement; Geometry geometry;
    Player* GetSession(){return this;} int GetSecurity()const{return SEC_PLAYER;}
    bool IsSelfMover()const{return selfMover;} bool hasUnitState(int)const{return false;}
    float GetSpeed(int)const{return 7;} bool HasAuraType(int)const{return false;}
    float GetPositionX()const{return float(pos.x);} float GetPositionY()const{return float(pos.y);}
    float GetPositionZ()const{return float(pos.z);} GenericTransport* GetTransport()const{return nullptr;}
    Geometry* GetMap(){return &geometry;} Geometry* GetTerrain(){return &geometry;}
    float GetTransOffsetX()const{return 0;} float GetTransOffsetY()const{return 0;} float GetTransOffsetZ()const{return 0;}
    Player* GetMover(){return this;} bool IsPlayer()const{return true;}
    bool IsBeingTeleported()const{return teleport;} bool IsFreeFlying()const{return false;}
    void SetCanFly(bool){} void SetLaunched(bool v){launched=v;}
    ObjectGuid GetObjectGuid()const{return guid;} ObjectGuid GetPackGUID()const{return guid;}
    void SendMessageToSetExcept(WorldPacket&,Player*){++relays;}
};
using Unit=Player;
struct Anticheat {
    bool browser=true; uint32 counter=99; unsigned badOrders=0;
    Player* _me=nullptr; Anticheat* _anticheat=this;
    RealmBrowser::KnockbackReceipt _browserKnockbackReceipt; RealmBrowser::KnockbackEnvelope _browserKnockback;
    RealmBrowser::MovementBudget _browserBudget; RealmBrowser::AirborneCeiling _browserAir;
    bool _browserKnockbackAckStaged=false,_browserHasFrame=false,_browserSlowFall=false,_inKnockBack=false;
    ObjectGuid _browserFrame=0; double _browserLastAirZ=0; uint32 _browserKnockbackCounter=0; float _jumpInitialSpeed=0;
    std::string lastReason;
    std::vector<std::pair<uint16,uint32>> orders;
    void OrderSent(uint16 opcode,uint32 serial){counter=_browserKnockbackCounter=serial;orders.emplace_back(opcode,serial);}
    void OrderAck(uint16 opcode,uint32 serial);
    MovementInfo& GetLastMovementInfo(){return _me->movement;}
    void KnockBack(float,float,float,float);
    void VerifyMovementFlags(uint32,uint32& remove,bool)const{remove=0;}
    void RecordCheatInternal(int,char const*,char const* reason){lastReason=reason;}
    void ExpireBrowserKnockback(){
        if(_browserKnockback.Expired(clockNow)){
            _browserKnockback.End();_browserKnockbackReceipt.Clear();_browserKnockbackAckStaged=false;
            _browserBudget.Reset(clockNow,7);_browserAir.Reset(clockNow,_me->pos.z);
        }
    }
    bool CheckBrowserMovement(MovementInfo&,uint16);
    bool PolicyAck(uint32,MovementInfo const&);
    bool KnockBackAck(uint32 serial,MovementInfo const& mi){
        if(!browser)return true;
        return PolicyAck(serial,mi);
    }
};
struct WorldSession {
    Player player; Player* _player=&player; Anticheat ac; Anticheat* m_anticheat=&ac;
    uint32 counter=0; unsigned processCalls=0,sends=0;
    int security=SEC_PLAYER; int GetSecurity()const{return security;}
    WorldSession(){ac._me=&player;ac._browserBudget.Reset(clockNow,7);}
    Player* GetPlayer(){return _player;} uint32 GetOrderCounter()const{return counter;}
    void IncrementOrderCounter(){++counter;}
    void SendPacket(WorldPacket const& p){
        ++sends; assert(!ac.orders.empty());
        assert(ac.orders.back()==std::make_pair(uint16(p.GetOpcode()),counter));
    }
    bool ProcessMovementInfo(MovementInfo& mi,Unit*,Player*,WorldPacket& packet){
        ++processCalls;
        if(ac.browser && !ac.CheckBrowserMovement(mi,uint16(packet.GetOpcode())))return false;
        player.pos=mi.pos;player.movement=mi;return true;
    }
    void SendKnockBack(Unit*,float,float,float);
    void HandleMoveKnockBackAck(WorldPacket&);
};
struct BrowserSession {
    WorldSession* _session; Anticheat* _movementData; bool _inWorld=true;
    bool KnockBackAck(uint32,MovementInfo const&);
};
'''

CHECKS = r'''
void Anticheat::OrderAck(uint16 opcode,uint32 serial){
    for(auto i=orders.begin();i!=orders.end();++i)
        if(GetOrderResponse(i->first)==opcode && i->second==serial){orders.erase(i);return;}
    ++badOrders;
}
int main(){
    assert(GetOrderResponse(SMSG_MOVE_KNOCK_BACK)==CMSG_MOVE_KNOCK_BACK_ACK);
    auto issue=[](WorldSession& s){s.SendKnockBack(&s.player,3.14159265358979323846f,10,10);};
    auto ack=[](){return WorldPacket(CMSG_MOVE_KNOCK_BACK_ACK);};
    WorldSession absent; auto a=ack(); absent.HandleMoveKnockBackAck(a);
    assert(absent.processCalls==0 && absent.player.relays==0);
    WorldSession good;issue(good);assert(good.counter==1 && good.sends==1);
    assert(good.ac.orders.back().second==0); // Actual first server counter.
    a=ack();good.HandleMoveKnockBackAck(a);
    assert(good.processCalls==1 && good.player.relays==1 && good.ac.badOrders==0);
    good.HandleMoveKnockBackAck(a);assert(good.processCalls==1); // Replay before ProcessMovementInfo.
    for(int fault=0;fault<6;++fault){
        WorldSession s;issue(s);auto bad=ack();
        if(fault==0)bad.counter=1;
        if(fault==1)bad.guid=3;
        if(fault==2)bad.movement.jump.cosAngle=1;
        if(fault==3)bad.movement.jump.zspeed=std::numeric_limits<float>::quiet_NaN();
        if(fault==4)bad.movement.jump.xyspeed=100;
        if(fault==5)bad.movement.moveFlags=0;
        s.HandleMoveKnockBackAck(bad);assert(s.processCalls==0 && s.player.relays==0);
        a=ack();s.HandleMoveKnockBackAck(a);assert(s.processCalls==1);
    }
    WorldSession superseded;issue(superseded);issue(superseded);
    a=ack();superseded.HandleMoveKnockBackAck(a);assert(superseded.processCalls==0);
    a.counter=1;superseded.HandleMoveKnockBackAck(a);assert(superseded.processCalls==1);
    WorldSession expired;issue(expired);clockNow+=60001;
    a=ack();expired.HandleMoveKnockBackAck(a);assert(expired.processCalls==0);
    clockNow=1000;
    WorldSession teleported;issue(teleported);teleported.ac._browserKnockbackReceipt.Clear();
    a=ack();teleported.HandleMoveKnockBackAck(a);assert(teleported.processCalls==0);
    WorldSession forgedPose;issue(forgedPose);a=ack();a.movement.pos.x=1000;
    forgedPose.HandleMoveKnockBackAck(a);assert(forgedPose.processCalls==1 && forgedPose.player.relays==0);
    a=ack();forgedPose.HandleMoveKnockBackAck(a);assert(forgedPose.player.relays==1); // Negative did not consume.
    for(int fault=0;fault<5;++fault){
        WorldSession s;issue(s);a=ack();
        if(fault==0)s.player.geometry.wall=true;
        if(fault==1)a.movement.pos.z=50;
        if(fault==2)a.movement.pos.x=39;
        if(fault==3)a.movement.moveFlags|=MOVEFLAG_CAN_FLY;
        if(fault==4)a.movement.moveFlags|=MOVEFLAG_ONTRANSPORT;
        s.HandleMoveKnockBackAck(a);assert(s.player.relays==0 && s.ac._browserKnockbackReceipt.Pending());
        s.player.geometry.wall=false;a=ack();s.HandleMoveKnockBackAck(a);assert(s.player.relays==1);
    }
    WorldSession staged;issue(staged);a=ack();assert(staged.ac.KnockBackAck(0,a.movement));
    MovementInfo ordinary;ordinary.moveFlags=0;WorldPacket plain(MSG_MOVE_HEARTBEAT);
    assert(staged.ProcessMovementInfo(ordinary,&staged.player,&staged.player,plain));
    assert(staged.ac._browserKnockbackReceipt.Pending()); // Only the matching ACK can commit.
    staged.HandleMoveKnockBackAck(a);assert(staged.player.relays==1);
    for(uint32 delay:{499u,3000u}){
        clockNow=1000;WorldSession moving;
        moving.SendKnockBack(&moving.player,1.57079632679489661923f,10,10);
        clockNow+=delay;a=ack();a.movement.pos.x=3.493;
        a.movement.jump.cosAngle=0;a.movement.jump.sinAngle=1;
        moving.HandleMoveKnockBackAck(a);
        assert(moving.player.relays==1 && !moving.ac._browserKnockbackReceipt.Pending());
        assert(std::abs(moving.ac._browserKnockback.Origin().x-3.493)<.001);
        clockNow+=150;MovementInfo flight=a.movement;flight.pos={3.493,1.5,11.282};
        WorldPacket heartbeat(MSG_MOVE_HEARTBEAT);
        assert(moving.ProcessMovementInfo(flight,&moving.player,&moving.player,heartbeat));
        assert(moving.ac._browserKnockback.Expired(61001)); // Receipt ACK never renews issue time.
    }
    clockNow=1000;WorldSession fakeJump;MovementInfo flight;flight.pos.z=50;
    WorldPacket heartbeat(MSG_MOVE_HEARTBEAT);
    assert(!fakeJump.ProcessMovementInfo(flight,&fakeJump.player,&fakeJump.player,heartbeat));
    WorldSession stock;stock.ac.browser=false;a=ack();stock.HandleMoveKnockBackAck(a);
    assert(stock.processCalls==1); // Null/disabled policy retains stock behavior.
    NullPolicy stockInterface;assert(stockInterface.KnockBackAck(99,a.movement));
    WorldSession guarded;BrowserSession gate{&guarded,&guarded.ac,true};
    assert(!gate.KnockBackAck(0,a.movement)); // Enabled policy cannot invent a receipt.
    issue(guarded);gate._inWorld=false;assert(!gate.KnockBackAck(0,a.movement));
    gate._inWorld=true;assert(gate.KnockBackAck(0,a.movement));
    gate._movementData=nullptr;assert(!gate.KnockBackAck(0,a.movement));
    guarded.security=3;assert(gate.KnockBackAck(0,a.movement));
    guarded.security=SEC_PLAYER;guarded.player.selfMover=false;assert(gate.KnockBackAck(0,a.movement));
}
'''


def run(source_root, compiler):
    movement = (source_root/'src/game/Anticheat/module/Movement/movement.cpp').read_text(encoding='utf-8')
    header = (source_root/'src/game/Anticheat/module/Movement/movement.hpp').read_text(encoding='utf-8')
    signatures = re.findall(r'\bbool\s+CheckBrowserMovement\s*\([^;{}]*\)\s*;', header)
    if len(signatures) != 1:
        raise ValueError('Expected exactly one actual CheckBrowserMovement declaration')
    # The real declaration must compile against the real definition. Supplying
    # an independently corrected fake would hide a broken source carry.
    prelude = PRELUDE.replace('bool CheckBrowserMovement(MovementInfo&,uint16);', signatures[0])
    native = (source_root/'src/game/MotionGenerators/MovementHandler.cpp').read_text(encoding='utf-8')
    module = (source_root/'src/game/Anticheat/module/libanticheat.cpp').read_text(encoding='utf-8')
    interface = (source_root/'src/game/Anticheat/Anticheat.hpp').read_text(encoding='utf-8')
    response = method(movement, 'uint16 GetOrderResponse(')
    policy = method(movement, 'bool Movement::KnockBackAck(').replace('Movement::KnockBackAck', 'Anticheat::PolicyAck')
    policy += method(movement, 'void Movement::KnockBack(').replace('Movement::KnockBack', 'Anticheat::KnockBack')
    policy += method(movement, 'bool Movement::CheckBrowserMovement(').replace('Movement::CheckBrowserMovement', 'Anticheat::CheckBrowserMovement')
    constants = sorted(set(re.findall(r'\b(?:SMSG|CMSG)_[A-Z_]+\b', response)))
    # Include these even in the old source so baseline compiles and fails its assertion.
    constants = sorted(set(constants) | {'SMSG_MOVE_KNOCK_BACK', 'CMSG_MOVE_KNOCK_BACK_ACK', 'MSG_MOVE_KNOCK_BACK','MSG_MOVE_HEARTBEAT'})
    declarations = '\n'.join(f'constexpr int {name}={number};' for number, name in enumerate(constants, 1))
    gate = method(module, 'bool SessionAnticheat::KnockBackAck(').replace('SessionAnticheat::','BrowserSession::')
    default = 'struct NullPolicy {' + method(interface,'virtual bool KnockBackAck(') + '};\n'
    source = declarations + prelude + response + policy + gate + default + '\n'.join(method(native, signature) for signature in (
        'void WorldSession::SendKnockBack(', 'void WorldSession::HandleMoveKnockBackAck(')) + CHECKS
    with tempfile.TemporaryDirectory(prefix='realm-native-knockback-') as temporary:
        root = Path(temporary)
        cpp, binary = root/'native.cpp', root/('native.exe' if Path(compiler).stem.lower() == 'cl' else 'native')
        cpp.write_text(source, encoding='utf-8')
        if Path(compiler).stem.lower() == 'cl':
            command = [compiler, '/nologo', '/std:c++17', '/EHsc', '/I'+str(Path(__file__).parent), str(cpp),
                       '/Fo:'+str(root/'native.obj'), '/Fe:'+str(binary)]
        else:
            command = [compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', str(Path(__file__).parent),
                       str(cpp), '-o', str(binary)]
        subprocess.run(command, cwd=root, check=True)
        subprocess.run([str(binary)], cwd=root, check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--compiler', default='g++')
    args = parser.parse_args()
    run(args.source, args.compiler)

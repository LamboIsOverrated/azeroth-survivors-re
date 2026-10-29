"""Compile actual patched dispatch methods with narrow engine-boundary fakes.

This proves dispatch ordering/lifetime-independent Warden guards, not world physics.
Full image compilation and an isolated real-client drill remain separate gates.
"""
import argparse
from pathlib import Path
import subprocess
import tempfile


def method(source, signature):
    start = source.index(signature)
    opening = source.index('{', start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


PRELUDE = r'''
#include "BrowserMovementBudget.h"
#include <cassert>
#include <memory>
#include <utility>
#include <vector>
constexpr int CMSG_SET_ACTIVE_MOVER=1, MOVEFLAG_ONTRANSPORT=2, TYPEID_PLAYER=3;
struct WorldPacket { int opcode=0; int GetOpcode() const { return opcode; } };
struct MovementInfo { bool transport=false; bool HasMovementFlag(int) const { return transport; }
    int GetTransportGuid() const { return 4; } };
struct Player { int GetTypeId() const { return TYPEID_PLAYER; } Player* GetMover() { return this; } };
struct Session { Player player; int packets=0,kicks=0; Player* GetPlayer() { return &player; }
    void SendPacket(WorldPacket&,bool) { ++packets; } void KickPlayer() { ++kicks; } };
struct FakeWarden { int packets=0; void SetCharEnumPacket(WorldPacket&&) { ++packets; }
    void HandlePacket(WorldPacket&) { ++packets; } };
struct Checks {
    bool browser=true,heuristic=true,teleport=true; int transports=0; std::vector<int> calls;
    bool CheckBrowserMovement(MovementInfo&,int) { calls.push_back(1); return browser; }
    bool HandleAnticheatTests(MovementInfo&,Session*,const WorldPacket&) { calls.push_back(2); return heuristic; }
    bool CheckTeleport(int,MovementInfo&) { calls.push_back(3); return teleport; }
    void OnTransport(Player*,int) { ++transports; }
};
struct SessionAnticheat {
    bool _inWorld=true; Checks* _movementData=nullptr; Session* _session=nullptr;
    std::unique_ptr<FakeWarden> _warden;
    void EnterWorld() { _inWorld=true; }
    bool Movement(MovementInfo&,const WorldPacket&);
    void SendCharEnum(WorldPacket&&);
    void WardenPacket(WorldPacket&);
};
void CheckHooks();
'''

CHECKS = r'''
int main() {
    CheckHooks();
    Session session; SessionAnticheat ac; Checks checks; WorldPacket packet; MovementInfo mi;
    ac._session=&session; ac._movementData=&checks;
    assert(ac.Movement(mi,packet));
    assert((checks.calls==std::vector<int>{2,3,1}));
    int expected=0;
    for (int failed : {2,3,1}) {
        ++expected;
        checks=Checks{}; checks.browser=failed!=1; checks.heuristic=failed!=2; checks.teleport=failed!=3;
        mi.transport=true; assert(!ac.Movement(mi,packet));
        assert(checks.calls.size()==static_cast<unsigned>(expected)); assert(checks.transports==0);
    }
    checks=Checks{}; assert(ac.Movement(mi,packet)); assert(checks.transports==1);
    ac._movementData=nullptr; assert(!ac.Movement(mi,packet));
    ac.SendCharEnum(WorldPacket{}); assert(session.packets==1);
    ac.WardenPacket(packet); assert(session.kicks==1);
    ac._warden=std::make_unique<FakeWarden>();
    ac.SendCharEnum(WorldPacket{}); ac.WardenPacket(packet);
    assert(ac._warden->packets==2); assert(session.packets==1); assert(session.kicks==1);
}
'''

HOOKS = r'''
using WorldSession=Session;
using uint32=unsigned;
struct Position { float x,y,z,o; };
enum UnitMoveType { MOVE_WALK,MOVE_RUN,MOVE_RUN_BACK,MOVE_SWIM,MOVE_SWIM_BACK,MOVE_TURN_RATE,MAX_MOVE_TYPE };
constexpr int CMSG_FORCE_WALK_SPEED_CHANGE_ACK=101,CMSG_FORCE_RUN_SPEED_CHANGE_ACK=102,
    CMSG_FORCE_RUN_BACK_SPEED_CHANGE_ACK=103,CMSG_FORCE_SWIM_SPEED_CHANGE_ACK=104,
    CMSG_FORCE_SWIM_BACK_SPEED_CHANGE_ACK=105,CMSG_FORCE_TURN_RATE_CHANGE_ACK=106;
template<class... A> void DetailLog(char const*, A...) {}
#define DETAIL_LOG(...) DetailLog(__VA_ARGS__)
uint32 hookClock=1000;
struct WorldTimer { static uint32 getMSTime() { return hookClock; } };
constexpr int SPELL_AURA_FEATHER_FALL=200;
struct ObjectGuid { unsigned value=0; };
struct GenericTransport {
    void CalculatePassengerOffset(float& x,float& y,float& z) { x-=100; y-=100; z-=200; }
    ObjectGuid GetObjectGuid() { return {7}; }
};
struct HookPlayer {
    bool launched=true;
    float x=1, y=2, z=1000;
    GenericTransport* transport=nullptr;
    GenericTransport* GetTransport() { return transport; }
    float GetSpeed(UnitMoveType) { return 7; }
    float GetSpeedRate(UnitMoveType) { return 1; }
    void SetSpeedRate(UnitMoveType,float,bool) {}
    char const* GetName() { return "Test"; }
    float GetPositionX() { return x; } float GetPositionY() { return y; }
    float GetPositionZ() { return z; } float GetOrientation() { return 0; }
    bool HasAuraType(int) { return false; }
    void SetLaunched(bool value) { launched=value; }
};
struct HookMovement {
    HookPlayer* _me; bool _justTeleported=false, _inKnockBack=false; int diagnostics=0;
    float clientSpeeds[6]{}; RealmBrowser::MovementBudget _browserBudget;
    RealmBrowser::AirborneCeiling _browserAir; RealmBrowser::KnockbackEnvelope _browserKnockback;
    RealmBrowser::KnockbackReceipt _browserKnockbackReceipt;
    bool _browserKnockbackAckStaged=false;
    std::vector<std::pair<bool,uint32>> _worldChangeHistory;
    ObjectGuid _browserFrame; double _browserLastAirZ=0;
    bool _browserHasFrame=false, _browserSlowFall=false;
    void ResetBrowserMovement();
    bool HandleAnticheatTests(MovementInfo&,WorldSession*,WorldPacket const&) {
        ++diagnostics; _justTeleported=false; return true;
    }
    void HandleTeleport(Position const&);
    void ExpireBrowserKnockback();
    void HandleEnterWorld();
    bool HandleSpeedChangeAck(MovementInfo&,WorldSession*,WorldPacket const&,float);
};
'''

HOOK_CHECKS = r'''
void CheckHooks() {
    HookPlayer player; HookMovement hooks{}; hooks._me=&player; Session session; MovementInfo mi;
    auto fall=[](double t){return RealmBrowser::FallElevation(t,false);};
    hooks._browserAir.Reset(1000,100); hookClock=3000;
    hooks._browserKnockbackReceipt.Issue(1000,0,1,0,10,-10);
    hooks.HandleTeleport({1,2,1000,0});
    assert(!hooks._browserKnockbackReceipt.Pending());
    assert(hooks._browserHasFrame && hooks._browserLastAirZ==1000 && !player.launched);
    WorldPacket ack; ack.opcode=CMSG_FORCE_RUN_SPEED_CHANGE_ACK;
    assert(hooks.HandleSpeedChangeAck(mi,&session,ack,7));
    assert(hooks.diagnostics==0); // Common movement validation, not an earlier duplicate pass.
    assert(hooks._browserAir.Accept(3100,1000,1000,false,fall));
    assert(!hooks._browserAir.Accept(3101,1039,1000,false,fall));
    assert(!hooks._browserBudget.Accept(3100,39,7));
    hooks._browserKnockback.Start(1000,{1,2,1000},10,-12,1,0);
    hooks._browserHasFrame=false;
    hookClock=61001; hooks.ExpireBrowserKnockback();
    assert(hooks._browserHasFrame && !hooks._browserKnockback.Active());
    GenericTransport transport; player.transport=&transport;
    // Far worldport callback carries LOCAL offsets after UpdatePassengerPosition.
    player.x=101; player.y=102; player.z=203; hookClock=62000;
    hooks.HandleTeleport({1,2,3,0});
    assert(hooks._browserFrame.value==7 && hooks._browserLastAirZ==3);
    assert(hooks._browserAir.Accept(62100,3,3,false,fall)); // Airborne passenger.
    assert(!hooks._browserAir.Accept(62101,42,3,false,fall));
    // Near callback carries WORLD coordinates: the same authoritative pose wins.
    hookClock=63000; hooks.HandleTeleport({101,102,203,0});
    assert(hooks._browserLastAirZ==3);
    assert(hooks._browserAir.Accept(63100,3,3,false,fall));
    // Ordinary world teleport has no transport transform at all.
    player.transport=nullptr; player.z=500; hookClock=64000;
    hooks.HandleTeleport({1,2,500,0});
    assert(hooks._browserFrame.value==0 && hooks._browserLastAirZ==500);
    assert(hooks._browserAir.Accept(64100,500,500,false,fall));
    hooks._browserKnockbackReceipt.Issue(64000,0,1,0,10,-10);
    hooks._browserKnockback.Start(64000,{1,2,500},10,-10,1,0);
    player.launched=true;
    hooks.HandleEnterWorld();
    assert(!hooks._browserKnockbackReceipt.Pending() && !hooks._browserKnockbackAckStaged);
    assert(!hooks._browserKnockback.Active() && !player.launched);
}
'''


def run(source_root, compiler):
    source = (source_root/'src/game/Anticheat/module/libanticheat.cpp').read_text(encoding='utf-8')
    methods = '\n'.join(method(source, signature) for signature in (
        'bool SessionAnticheat::Movement(', 'void SessionAnticheat::SendCharEnum(',
        'void SessionAnticheat::WardenPacket('))
    movement = (source_root/'src/game/Anticheat/module/Movement/movement.cpp').read_text(encoding='utf-8')
    hooks = '\n'.join(method(movement, signature).replace('Movement::', 'HookMovement::') for signature in (
        'void Movement::ResetBrowserMovement(', 'void Movement::HandleTeleport(', 'void Movement::ExpireBrowserKnockback(',
        'void Movement::HandleEnterWorld(',
        'bool Movement::HandleSpeedChangeAck('))
    with tempfile.TemporaryDirectory(prefix='realm-anticheat-dispatch-') as temporary:
        root = Path(temporary)
        cpp = root/'dispatch.cpp'
        cpp.write_text(PRELUDE + methods + CHECKS + HOOKS + hooks + HOOK_CHECKS, encoding='utf-8')
        binary = root/('dispatch.exe' if Path(compiler).stem.lower() == 'cl' else 'dispatch')
        if Path(compiler).stem.lower() == 'cl':
            command = [compiler, '/nologo', '/std:c++17', '/EHsc', '/I' + str(Path(__file__).parent), str(cpp),
                       '/Fo:' + str(root/'dispatch.obj'), '/Fe:' + str(binary)]
        else:
            command = [compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', str(Path(__file__).parent), str(cpp), '-o', str(binary)]
        subprocess.run(command, cwd=root, check=True)
        subprocess.run([str(binary)], cwd=root, check=True)
    from check_knockback_contract import run as check_knockback
    check_knockback(source_root, compiler)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--compiler', default='g++')
    args = parser.parse_args()
    run(args.source, args.compiler)

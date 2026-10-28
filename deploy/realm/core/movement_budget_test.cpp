#include "BrowserMovementBudget.h"
#include <cassert>
#include <limits>

int main()
{
    RealmBrowser::KnockbackReceipt receipt;
    assert(!receipt.Consume(1000, 0, 8192, -1, 0, 10, -10)); // No server-issued launch.
    assert(receipt.Issue(1000, 0, -1, 0, 10, -10));
    assert(!receipt.Consume(1100, 1, 8192, -1, 0, 10, -10));
    assert(!receipt.Consume(1100, 0, 0, -1, 0, 10, -10));
    assert(!receipt.Consume(1100, 0, 8192, 1, 0, 10, -10));
    assert(!receipt.Consume(1100, 0, 8192, -1, 0, 10, std::numeric_limits<double>::quiet_NaN()));
    assert(receipt.Consume(1100, 0, 8192, -1, 0, 10, -10)); // Native first counter is zero.
    assert(!receipt.Consume(1101, 0, 8192, -1, 0, 10, -10)); // One consume, no replay.
    assert(receipt.Issue(2000, 1, -1, 0, 10, -10));
    assert(receipt.Issue(2001, 2, 1, 0, 5, -5));
    assert(!receipt.Consume(2002, 1, 8192, -1, 0, 10, -10)); // Superseded receipt.
    assert(receipt.Consume(2002, 2, 8192, 1, 0, 5, -5));
    assert(receipt.Issue(3000, 3, -1, 0, 10, -10));
    assert(!receipt.Consume(63001, 3, 8192, -1, 0, 10, -10)); // Same 60s server limit.
    assert(receipt.Issue(0xfffffff0u, 0, -1, 0, 10, -10));
    assert(receipt.Consume(84, 0, 8192, -1, 0, 10, -10)); // Server clock wraps.
    assert(!receipt.Issue(1000, 0, 0, 0, 10, -10));
    RealmBrowser::MovementBudget normal;
    assert(normal.Accept(1000, 0, 7));
    for (unsigned t = 1100; t < 120000; t += 100)
        assert(normal.Accept(t, .7, 7));
    // Packet bursts have bounded grace; the client's clock is never an input.
    assert(normal.Accept(120000, 7, 7));
    RealmBrowser::MovementBudget attack;
    assert(attack.Accept(1000, 0, 7));
    assert(!attack.Accept(1001, 1000, 7));
    unsigned accepted = 0;
    for (unsigned t = 1100; t < 11000; t += 100)
        accepted += attack.Accept(t, 7, 7);
    assert(accepted < 15); // 10x movement cannot consume more than server time + burst.
    assert(attack.Reset(12000, 7)); // authoritative server callback
    assert(attack.Accept(12000, 0, 7));
    assert(attack.Accept(12100, .7, 7));
    assert(!attack.Accept(12200, std::numeric_limits<double>::quiet_NaN(), 7));
    assert(!attack.Accept(12200, 1, std::numeric_limits<double>::infinity()));
    RealmBrowser::MovementBudget wrap;
    assert(wrap.Accept(0xfffffff0u, 0, 7));
    assert(wrap.Accept(84, .7, 7)); // server timer wrap
    RealmBrowser::MovementBudget rooted;
    assert(rooted.Accept(1000, 0, 0));
    assert(!rooted.Accept(2000, 2, 0));
    RealmBrowser::AirborneCeiling air;
    auto fall = [](double seconds) { return .5 * 19.291105 * seconds * seconds - 7.955547 * seconds; };
    assert(air.Accept(1000, 0, 0, true, fall));
    for (unsigned elapsed = 50; elapsed < 800; elapsed += 50)
        assert(air.Accept(1000 + elapsed, -fall(elapsed / 1000.0), 0, false, fall));
    assert(air.Accept(1800, 0, 0, true, fall));
    assert(!air.Accept(1850, 100, 0, false, fall));
    assert(!air.Accept(6000, 5, 0, false, fall)); // hovering cannot restart the jump clock
    assert(air.Reset(6100, 1000));
    assert(air.Accept(6200, 1000.5, 1000, false, fall));
    assert(!air.Accept(6201, std::numeric_limits<double>::infinity(), 1000, false, fall));
    assert(std::abs(RealmBrowser::FallElevation(10, true) -
                    RealmBrowser::FallElevation(9, true) - 7.0) < .00001);
    assert(std::abs(RealmBrowser::FallElevation(10, false) -
                    RealmBrowser::FallElevation(9, false) - 60.148003) < .00001);
    assert(RealmBrowser::FallElevation(.4, true) < 0); // jumping still rises first
    assert(RealmBrowser::TransportCoordinatesValid(2, -2, 3, 1, 0, 0));
    assert(!RealmBrowser::TransportCoordinatesValid(-5000, 0, 0, 0, 0, 0));
    assert(!RealmBrowser::TransportCoordinatesValid(0, 0, 0, 100, 0, 0));
    assert(!RealmBrowser::TransportCoordinatesValid(0, 0, 0, 0, 0,
            std::numeric_limits<double>::quiet_NaN()));
    RealmBrowser::MovementBudget teleportedBudget;
    teleportedBudget.Reset(1000, 7);
    assert(!teleportedBudget.Accept(1001, 39, 7));
    RealmBrowser::AirborneCeiling teleportedAir;
    teleportedAir.Reset(1000, 100);
    assert(!teleportedAir.Accept(3000, 100, 100, false, fall));
    teleportedAir.Reset(3001, 1000); // server callback; no packet exemption
    assert(teleportedAir.Accept(3100, 1000, 1000, false, fall));
    assert(!teleportedAir.Accept(3101, 1039, 1000, false, fall));
    RealmBrowser::AirborneCeiling frame;
    frame.Reset(1000, 3);
    frame.Rebase(200); // leaving local deck Z=3 for authoritative world Z=203
    assert(frame.Accept(1100, 203.5, 203, false, fall));
    assert(!frame.Accept(5000, 203, 203, false, fall)); // changing frame did not reset clock
    RealmBrowser::KnockbackEnvelope knock;
    assert(knock.Start(1000, {0, 0, 10}, 10, -12, 1, 0));
    assert(knock.Check(1500, {5, 0, 13.5}, false, false));
    assert(!knock.Check(1501, {5000, 0, 13.5}, false, false));
    assert(!knock.Check(11000, {50, 0, 13.5}, false, false)); // withholding LAND cannot hover
    assert(!knock.Check(11000, {5000, 0, 10}, true, false));
    assert(knock.Check(2300, {13, 0, 10}, true, false)); // server-verified landing, no opcode needed
    assert(!knock.Active());
    assert(knock.Start(0xfffffff0u, {0, 0, 10}, 10, -12, 1, 0));
    assert(knock.Check(84, {1, 0, 11}, false, false));
    assert(knock.Expired(60001u));
    RealmBrowser::KnockbackEnvelope coherent;
    assert(coherent.Start(1000, {0, 0, 10}, 10, -12, 1, 0));
    assert(!coherent.Check(4000, {30, 0, 10}, true, false)); // XY and Z must describe the same flight time
    RealmBrowser::KnockbackEnvelope late;
    assert(late.Start(1000, {0, 0, 10}, 10, -10, 0, 1));
    assert(late.RebaseAtReceipt(4000, {3.493, 0, 10}));
    assert(late.Check(4150, {3.493, 1.5, 11.282}, false, false));
    assert(late.Expired(61001)); // ACK rebase cannot renew original issue authority.
}

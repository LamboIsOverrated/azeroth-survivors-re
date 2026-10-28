#include "BrowserMovementBudget.h"
#include <cassert>
#include <limits>

int main()
{
    RealmBrowser::MovementBudget normal;
    assert(normal.Accept(1000, 0, 7, false));
    for (unsigned t = 1100; t < 120000; t += 100)
        assert(normal.Accept(t, .7, 7, false));
    // Packet bursts have bounded grace; the client's clock is never an input.
    assert(normal.Accept(120000, 7, 7, false));
    RealmBrowser::MovementBudget attack;
    assert(attack.Accept(1000, 0, 7, false));
    assert(!attack.Accept(1001, 1000, 7, false));
    unsigned accepted = 0;
    for (unsigned t = 1100; t < 11000; t += 100)
        accepted += attack.Accept(t, 7, 7, false);
    assert(accepted < 15); // 10x movement cannot consume more than server time + burst.
    assert(attack.Accept(12000, 1000, 7, true)); // server-issued teleport
    assert(attack.Accept(12100, .7, 7, false));
    assert(!attack.Accept(12200, std::numeric_limits<double>::quiet_NaN(), 7, false));
    assert(!attack.Accept(12200, 1, std::numeric_limits<double>::infinity(), false));
    RealmBrowser::MovementBudget wrap;
    assert(wrap.Accept(0xfffffff0u, 0, 7, false));
    assert(wrap.Accept(84, .7, 7, false)); // server timer wrap
    RealmBrowser::MovementBudget rooted;
    assert(rooted.Accept(1000, 0, 0, false));
    assert(!rooted.Accept(2000, 2, 0, false));
    RealmBrowser::AirborneCeiling air;
    auto fall = [](double seconds) { return .5 * 19.291105 * seconds * seconds - 7.955547 * seconds; };
    assert(air.Accept(1000, 0, 0, true, false, fall));
    for (unsigned elapsed = 50; elapsed < 800; elapsed += 50)
        assert(air.Accept(1000 + elapsed, -fall(elapsed / 1000.0), 0, false, false, fall));
    assert(air.Accept(1800, 0, 0, true, false, fall));
    assert(!air.Accept(1850, 100, 0, false, false, fall));
    assert(!air.Accept(6000, 5, 0, false, false, fall)); // hovering cannot restart the jump clock
    assert(air.Accept(6100, 1000, 1000, false, true, fall));
    assert(air.Accept(6200, 1000.5, 1000, false, false, fall));
    assert(!air.Accept(6201, std::numeric_limits<double>::infinity(), 1000, false, false, fall));
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
}

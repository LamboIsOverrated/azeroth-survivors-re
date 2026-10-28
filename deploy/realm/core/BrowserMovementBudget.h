// Server receipt-time horizontal movement budget; no client clock or ban policy.
#ifndef REALM_BROWSER_MOVEMENT_BUDGET_H
#define REALM_BROWSER_MOVEMENT_BUDGET_H
#include <algorithm>
#include <cmath>
#include <cstdint>

namespace RealmBrowser
{
inline double FallElevation(double seconds, bool slowFall)
{
    // Pinned Movement/util.cpp constants and jump velocity. Unlike that helper,
    // both the terminal time and terminal segment honor the slow-fall terminal.
    constexpr double gravity = 19.29110527038574;
    constexpr double initial = -7.955547;
    const double terminal = slowFall ? 7.0 : 60.148003;
    const double terminalTime = (terminal - initial) / gravity;
    if (seconds <= terminalTime)
        return seconds * (initial + .5 * gravity * seconds);
    return terminalTime * (initial + .5 * gravity * terminalTime)
           + terminal * (seconds - terminalTime);
}

class MovementBudget
{
    bool initialized = false;
    std::uint32_t previous = 0;
    double credit = 0;
    double capacity = 0;
public:
    bool Accept(std::uint32_t now, double distance, double speed, bool serverExemption)
    {
        if (!std::isfinite(distance) || !std::isfinite(speed) || distance < 0 || speed < 0)
            return false;
        const double nextCapacity = speed * 2.0 + 1.0;
        if (!initialized || serverExemption)
        {
            initialized = true;
            credit = nextCapacity;
            previous = now;
        }
        else
        {
            // Unsigned subtraction handles the core's monotonic uint32 timer wrap.
            const std::uint32_t elapsed = now - previous;
            previous = now;
            credit = std::min(nextCapacity, credit + speed * elapsed / 1000.0
                              + std::max(0.0, nextCapacity - capacity));
        }
        capacity = nextCapacity;
        if (serverExemption)
            return true;
        if (distance > credit + 0.0001)
            return false;
        credit -= distance;
        return true;
    }
};

class AirborneCeiling
{
    bool airborne = false;
    std::uint32_t begin = 0;
    double origin = 0;
public:
    template<class FallElevation>
    bool Accept(std::uint32_t now, double z, double previousZ, bool onSurface,
                bool serverExemption, FallElevation fall)
    {
        if (!std::isfinite(z) || !std::isfinite(previousZ))
            return false;
        if (onSurface || serverExemption)
        {
            airborne = false;
            return true;
        }
        if (!airborne)
        {
            airborne = true;
            begin = now;
            origin = previousZ;
        }
        const double seconds = static_cast<std::uint32_t>(now - begin) / 1000.0;
        // The caller supplies the fall model with authoritative aura state.
        const double ceiling = origin - fall(seconds) + 2.0;
        return std::isfinite(ceiling) && z <= ceiling;
    }
};
}
#endif

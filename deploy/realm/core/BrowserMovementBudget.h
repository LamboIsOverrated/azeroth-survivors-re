// Server receipt-time horizontal movement budget; no client clock or ban policy.
#ifndef REALM_BROWSER_MOVEMENT_BUDGET_H
#define REALM_BROWSER_MOVEMENT_BUDGET_H
#include <algorithm>
#include <cmath>
#include <cstdint>

namespace RealmBrowser
{
class KnockbackReceipt
{
    bool pending = false;
    std::uint32_t issued = 0, counter = 0;
    double cosine = 0, sine = 0, xy = 0, vz = 0;
public:
    bool Issue(std::uint32_t now, std::uint32_t serial, double c, double s, double speedXY, double speedZ)
    {
        pending = false;
        if (!std::isfinite(c) || !std::isfinite(s) || !std::isfinite(speedXY) ||
            !std::isfinite(speedZ) || speedXY < 0 || std::abs(c*c + s*s - 1.0) > .01)
            return false;
        issued = now; counter = serial; cosine = c; sine = s; xy = speedXY; vz = speedZ;
        pending = true;
        return true;
    }
    bool Matches(std::uint32_t now, std::uint32_t serial, std::uint32_t flags,
                 double c, double s, double speedXY, double speedZ) const
    {
        if (!pending || std::uint32_t(now - issued) > 60000 || serial != counter ||
            !(flags & 0x00002000u) || !std::isfinite(c) || !std::isfinite(s) ||
            !std::isfinite(speedXY) || !std::isfinite(speedZ) ||
            std::abs(c-cosine) > .01 || std::abs(s-sine) > .01 ||
            std::abs(speedXY-xy) > .01 || std::abs(speedZ-vz) > .01)
            return false;
        return true;
    }
    bool Consume(std::uint32_t now, std::uint32_t serial, std::uint32_t flags,
                 double c, double s, double speedXY, double speedZ)
    {
        if (!Matches(now, serial, flags, c, s, speedXY, speedZ))
            return false;
        pending = false;
        return true;
    }
    bool Pending() const { return pending; }
    void Clear() { pending = false; }
};
inline double FallElevation(double seconds, bool slowFall, double initial = -7.955547)
{
    // Pinned Movement/util.cpp constants and jump velocity. Unlike that helper,
    // both the terminal time and terminal segment honor the slow-fall terminal.
    constexpr double gravity = 19.29110527038574;
    const double terminal = slowFall ? 7.0 : 60.148003;
    initial = std::min(initial, terminal);
    const double terminalTime = (terminal - initial) / gravity;
    if (seconds <= terminalTime)
        return seconds * (initial + .5 * gravity * seconds);
    return terminalTime * (initial + .5 * gravity * terminalTime)
           + terminal * (seconds - terminalTime);
}

inline bool TransportCoordinatesValid(double x, double y, double z,
                                     double worldDx, double worldDy, double worldDz)
{
    // Match the pinned transport offset bounds symmetrically, including negatives.
    // The bounded world delta allows receipt latency; accepted positions are then
    // rebased to the server transform, never to the submitted world coordinates.
    return std::isfinite(x) && std::isfinite(y) && std::isfinite(z) &&
        std::isfinite(worldDx) && std::isfinite(worldDy) && std::isfinite(worldDz) &&
        std::abs(x) <= 50 && std::abs(y) <= 50 && std::abs(z) <= 100 &&
        worldDx * worldDx + worldDy * worldDy + worldDz * worldDz <= 100.0;
}

class MovementBudget
{
    bool initialized = false;
    std::uint32_t previous = 0;
    double credit = 0;
    double capacity = 0;
public:
    bool Reset(std::uint32_t now, double speed)
    {
        if (!std::isfinite(speed) || speed < 0)
            return false;
        initialized = true;
        previous = now;
        capacity = credit = speed * 2.0 + 1.0;
        return true;
    }

    bool Accept(std::uint32_t now, double distance, double speed)
    {
        if (!std::isfinite(distance) || !std::isfinite(speed) || distance < 0 || speed < 0)
            return false;
        const double nextCapacity = speed * 2.0 + 1.0;
        if (!initialized)
            Reset(now, speed);
        else
        {
            // Unsigned subtraction handles the core's monotonic uint32 timer wrap.
            const std::uint32_t elapsed = now - previous;
            previous = now;
            credit = std::min(nextCapacity, credit + speed * elapsed / 1000.0
                              + std::max(0.0, nextCapacity - capacity));
        }
        capacity = nextCapacity;
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
    bool Reset(std::uint32_t now, double z)
    {
        if (!std::isfinite(z))
            return false;
        airborne = true;
        begin = now;
        origin = z;
        return true;
    }

    bool Rebase(double delta)
    {
        if (!std::isfinite(delta) || !std::isfinite(origin + delta))
            return false;
        if (airborne)
            origin += delta;
        return true;
    }

    template<class FallElevation>
    bool Accept(std::uint32_t now, double z, double previousZ, bool onSurface,
                FallElevation fall)
    {
        if (!std::isfinite(z) || !std::isfinite(previousZ))
            return false;
        if (onSurface)
        {
            airborne = false;
            return true;
        }
        if (!airborne)
        {
            Reset(now, previousZ);
        }
        const double seconds = static_cast<std::uint32_t>(now - begin) / 1000.0;
        // The caller supplies the fall model with authoritative aura state.
        const double ceiling = origin - fall(seconds) + 2.0;
        return std::isfinite(ceiling) && z <= ceiling;
    }
};

struct Point { double x, y, z; };

class KnockbackEnvelope
{
    bool active = false, sawAir = false;
    std::uint32_t begin = 0, issued = 0;
    Point origin{};
    double xy = 0, vz = 0, cosine = 0, sine = 0;
public:
    bool Start(std::uint32_t now, Point at, double speedXY, double speedZ, double c, double s)
    {
        active = false;
        if (!std::isfinite(at.x) || !std::isfinite(at.y) || !std::isfinite(at.z) ||
            !std::isfinite(speedXY) || !std::isfinite(speedZ) || !std::isfinite(c) || !std::isfinite(s) ||
            speedXY < 0 || std::abs(c * c + s * s - 1.0) > .01)
            return false;
        active = true; sawAir = false; begin = issued = now; origin = at;
        xy = speedXY; vz = speedZ; cosine = c; sine = s;
        return true;
    }
    bool Active() const { return active; }
    bool RebaseAtReceipt(std::uint32_t now, Point at)
    {
        if (!active || Expired(now) || !std::isfinite(at.x) || !std::isfinite(at.y) || !std::isfinite(at.z))
            return false;
        begin = now; origin = at; sawAir = false;
        return true; // The original issue-clock and absolute expiry never change.
    }
    bool Expired(std::uint32_t now) const { return active && std::uint32_t(now - issued) > 60000; }
    void End() { active = false; }
    double HorizontalSpeed() const { return xy; }
    Point Origin() const { return origin; }
    Point Predicted(std::uint32_t now, bool slowFall) const
    {
        const double t = std::uint32_t(now - begin) / 1000.0;
        return {origin.x + xy * cosine * t, origin.y + xy * sine * t,
                origin.z - FallElevation(t, slowFall, vz)};
    }
    bool Check(std::uint32_t now, Point p, bool onSurface, bool slowFall, bool collisionStopped = false)
    {
        if (!active || Expired(now) || !std::isfinite(p.x) || !std::isfinite(p.y) || !std::isfinite(p.z))
            return false;
        const double t = std::uint32_t(now - begin) / 1000.0;
        const double dx = p.x - origin.x, dy = p.y - origin.y;
        const double along = dx * cosine + dy * sine;
        const double side = -dx * sine + dy * cosine;
        if (along < -2 || along > xy * t + 2 || std::abs(side) > 2)
            return false;
        double earlier = std::max(0.0, t - 2.0), later = t;
        // A point must match one coherent flight time, not the fastest XY and
        // the highest Z from two different times in the latency window.
        if (xy > .001 && !(collisionStopped && onSurface))
        {
            earlier = std::max(earlier, (along - 2.0) / xy);
            later = std::min(later, (along + 2.0) / xy);
            if (earlier > later)
                return false;
        }
        const double za = origin.z - FallElevation(earlier, slowFall, vz);
        const double zb = origin.z - FallElevation(later, slowFall, vz);
        double high = std::max(za, zb);
        const double apex = -vz / 19.29110527038574;
        if (apex > earlier && apex < later)
            high = std::max(high, origin.z - FallElevation(apex, slowFall, vz));
        if (!(collisionStopped && onSurface) && (p.z > high + 2 || p.z < std::min(za, zb) - 2))
            return false;
        if (!onSurface)
            sawAir = true;
        else if (sawAir || t >= 2 || collisionStopped)
            active = false;
        return true;
    }
};
}
#endif

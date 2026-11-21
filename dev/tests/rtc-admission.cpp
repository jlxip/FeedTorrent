#include "libtorrent/aux_/rtc_offer_admission.hpp"
#include <cassert>
#include <chrono>
#include <iostream>
using libtorrent::aux::rtc_offer_admission;
using namespace std::chrono_literals;
using time_point = rtc_offer_admission::clock::time_point;
rtc_offer_admission::offer_id id(int n) {
    rtc_offer_admission::offer_id value{};
    for (int i=0;i<4;++i) value[i]=char((unsigned(n)>>(8*i))&255);
    return value;
}
int main() {
    time_point const start= time_point{}+100s;
    rtc_offer_admission a;
    a.configure(10,120s,start);
    for(int i=0;i<10;++i) assert(a.admit(id(i),start));
    assert(!a.admit(id(10),start));
    for(int i=0;i<1000;++i) a.configure(10,120s,start);
    assert(!a.admit(id(10),start)); // Announces must not bypass the rate limit.
    assert(!a.admit(id(10),start+99ms));
    assert(a.admit(id(10),start+100ms));
    assert(!a.admit(id(11),start+100ms));
    for(int i=0;i<10000;++i) assert(!a.admit(id(10),start+200ms));
    assert(a.admit(id(11),start+200ms)); // Duplicate traffic spent no credit.
    assert(!a.admit(id(12),start+200ms));
    for(int i=1;i<10;++i) assert(!a.admit(id(12),start+200ms+i*10ms));
    assert(a.admit(id(12),start+300ms)); // Fractional refill time is retained.
    a.configure(0,120s,start+300ms);
    assert(!a.admit(id(100),start+1h));
    a.configure(10,120s,start+1h);
    for(int i=0;i<10;++i) assert(a.admit(id(i),start+1h));
    assert(!a.admit(id(10),start+1h));
    for(int i=10;i<20;++i) assert(a.admit(id(i),start+100h));
    assert(!a.admit(id(20),start+100h)); // Long idle never creates an unbounded burst.
    assert(a.admit(id(10),start+100h+121s)); // Old IDs expire.
    rtc_offer_admission other;
    other.configure(10,120s,start);
    assert(other.admit(id(0),start)); // Another torrent/tracker has its own budget.
    rtc_offer_admission hostile;
    hostile.configure(10,120s,start);
    int accepted=0;
    for(int ms=0;ms<5000;++ms)
        for(int j=0;j<100;++j) accepted+=hostile.admit(id(100*ms+j),start+ms*1ms);
    assert(accepted==59); // 500000 fresh offers, only burst10 + 49 refills admitted.
    hostile.configure(-1,120s,start+5s);
    assert(!hostile.admit(id(999999),start+100h));
    std::cout << "PASS admission: continuous refill, duplicate flood, announce flood, fractional time, disable, idle bound, expiry and independent budgets\n";
}

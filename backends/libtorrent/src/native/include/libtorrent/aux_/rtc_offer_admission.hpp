#ifndef FEEDTORRENT_RTC_OFFER_ADMISSION_HPP
#define FEEDTORRENT_RTC_OFFER_ADMISSION_HPP

#include <algorithm>
#include <array>
#include <chrono>
#include <deque>
#include <set>

namespace libtorrent::aux {

// Per tracker/torrent: one burst of max_webtorrent_offers and the same number
// per second thereafter. Concurrent negotiations remain bounded separately by
// rtc_signaling. Neither tracker ACKs nor announces grant additional credits.
class rtc_offer_admission
{
public:
	using clock = std::chrono::steady_clock;
	using offer_id = std::array<char, 20>;

	void configure(int limit, std::chrono::seconds lifetime, clock::time_point now)
	{
		refill(now);
		limit = std::max(0, limit);
		if (m_limit == 0) m_credit = std::chrono::seconds(limit);
		m_limit = limit;
		m_credit = std::min(m_credit, std::chrono::nanoseconds(std::chrono::seconds(limit)));
		m_lifetime = lifetime;
		if (limit == 0) { m_seen.clear(); m_order.clear(); }
	}

	bool admit(offer_id const& id, clock::time_point now)
	{
		while (!m_order.empty() && m_order.front().second + m_lifetime <= now)
		{
			m_seen.erase(m_order.front().first);
			m_order.pop_front();
		}
		// Duplicate offers never consume a credit or refresh their retention.
		if (m_limit == 0 || m_seen.find(id) != m_seen.end()) return false;
		refill(now);
		if (m_credit < std::chrono::seconds(1)) return false;
		m_credit -= std::chrono::seconds(1);
		m_seen.insert(id);
		m_order.emplace_back(id, now);
		return true;
	}

private:
	void refill(clock::time_point now)
	{
		if (now <= m_updated) return;
		// A full bucket takes one second; clamp before multiplying to avoid
		// overflow after a long idle. Integer credits retain sub-token time.
		auto const elapsed = std::min(std::chrono::duration_cast<std::chrono::nanoseconds>(
			now - m_updated), std::chrono::nanoseconds(std::chrono::seconds(1)));
		m_credit = std::min(std::chrono::nanoseconds(std::chrono::seconds(m_limit)),
			m_credit + elapsed * m_limit);
		m_updated = now;
	}

	int m_limit = 0;
	std::chrono::nanoseconds m_credit{0};
	clock::time_point m_updated{};
	std::chrono::seconds m_lifetime{120};
	// Accepted IDs only: at rate N/s this retains at most N*(lifetime+1)
	// entries, regardless of the number of messages a hostile tracker sends.
	std::set<offer_id> m_seen;
	std::deque<std::pair<offer_id, clock::time_point>> m_order;
};

}
#endif

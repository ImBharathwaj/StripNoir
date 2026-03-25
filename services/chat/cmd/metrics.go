package main

import (
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

var chatDurationBucketsMs = []int{5, 25, 50, 100, 250, 500, 1000, 2500, 5000}

type histogram struct {
	mu      sync.Mutex
	count   int64
	sumMs   float64
	buckets map[int]int64
	inf     int64
}

func newHistogram() *histogram {
	h := &histogram{buckets: make(map[int]int64)}
	for _, b := range chatDurationBucketsMs {
		h.buckets[b] = 0
	}
	return h
}

// observe places each sample in a single exclusive upper-bound bucket (aligned with Node httpMetrics).
func (h *histogram) observe(ms float64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.count++
	h.sumMs += ms
	for _, b := range chatDurationBucketsMs {
		if ms <= float64(b) {
			h.buckets[b]++
			return
		}
	}
	h.inf++
}

type routeGroupStats struct {
	requests int64
	errors   int64
	hist     *histogram
}

type chatMetrics struct {
	mu        sync.Mutex
	startedAt time.Time
	byGroup   map[string]*routeGroupStats
}

func newChatMetrics() *chatMetrics {
	return &chatMetrics{
		startedAt: time.Now(),
		byGroup:   make(map[string]*routeGroupStats),
	}
}

func metricsEnabledGo() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("METRICS_ENABLED")))
	if v == "" {
		return false
	}
	return v == "1" || v == "true"
}

func chatPathGroup(path string) string {
	switch {
	case path == "/ws":
		return "websocket"
	case strings.HasPrefix(path, "/realtime/rooms/"):
		return "longpoll_room_events"
	case path == "/realtime/notify/events":
		return "longpoll_notify_events"
	case strings.HasPrefix(path, "/internal/"):
		return "internal_publish"
	case path == "/health" || path == "/health/deps":
		return "health"
	case path == "/metrics":
		return "metrics"
	default:
		return "other"
	}
}

func (m *chatMetrics) record(method, path string, status int, d time.Duration) {
	g := chatPathGroup(path)
	m.mu.Lock()
	gs, ok := m.byGroup[g]
	if !ok {
		gs = &routeGroupStats{hist: newHistogram()}
		m.byGroup[g] = gs
	}
	gs.requests++
	if status >= 500 {
		gs.errors++
	}
	m.mu.Unlock()
	gs.hist.observe(float64(d.Milliseconds()))
}

func (m *chatMetrics) prometheusText() string {
	m.mu.Lock()
	uptime := int64(time.Since(m.startedAt).Seconds())
	groups := make([]string, 0, len(m.byGroup))
	for g := range m.byGroup {
		groups = append(groups, g)
	}
	sort.Strings(groups)
	var b strings.Builder
	fmt.Fprintf(&b, "# HELP stripnoir_chat_process_uptime_seconds Uptime of the chat gateway process\n")
	fmt.Fprintf(&b, "# TYPE stripnoir_chat_process_uptime_seconds gauge\n")
	fmt.Fprintf(&b, "stripnoir_chat_process_uptime_seconds %d\n\n", uptime)
	fmt.Fprintf(&b, "# HELP stripnoir_chat_http_requests_total HTTP requests by route group\n")
	fmt.Fprintf(&b, "# TYPE stripnoir_chat_http_requests_total counter\n")
	fmt.Fprintf(&b, "# HELP stripnoir_chat_http_errors_total HTTP 5xx by route group\n")
	fmt.Fprintf(&b, "# TYPE stripnoir_chat_http_errors_total counter\n")
	for _, g := range groups {
		gs := m.byGroup[g]
		fmt.Fprintf(&b, "stripnoir_chat_http_requests_total{route_group=%q} %d\n", g, gs.requests)
		fmt.Fprintf(&b, "stripnoir_chat_http_errors_total{route_group=%q} %d\n", g, gs.errors)
	}
	fmt.Fprintf(&b, "\n# HELP stripnoir_chat_http_request_duration_ms histogram\n")
	fmt.Fprintf(&b, "# TYPE stripnoir_chat_http_request_duration_ms histogram\n")
	for _, g := range groups {
		gs := m.byGroup[g]
		gs.hist.mu.Lock()
		var cum int64
		for _, edge := range chatDurationBucketsMs {
			cum += gs.hist.buckets[edge]
			fmt.Fprintf(&b, "stripnoir_chat_http_request_duration_ms_bucket{route_group=%q,le=\"%d\"} %d\n", g, edge, cum)
		}
		cum += gs.hist.inf
		fmt.Fprintf(&b, "stripnoir_chat_http_request_duration_ms_bucket{route_group=%q,le=\"+Inf\"} %d\n", g, cum)
		sum := gs.hist.sumMs
		cnt := gs.hist.count
		gs.hist.mu.Unlock()
		fmt.Fprintf(&b, "stripnoir_chat_http_request_duration_ms_sum{route_group=%q} %g\n", g, sum)
		fmt.Fprintf(&b, "stripnoir_chat_http_request_duration_ms_count{route_group=%q} %d\n", g, cnt)
	}
	fmt.Fprintf(&b, "\n")
	m.mu.Unlock()
	return b.String()
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func withChatRequestMetrics(m *chatMetrics, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/metrics" {
			next.ServeHTTP(w, r)
			return
		}
		sr := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		t0 := time.Now()
		next.ServeHTTP(sr, r)
		m.record(r.Method, path, sr.status, time.Since(t0))
	})
}

func metricsHandler(m *chatMetrics) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(m.prometheusText()))
	}
}

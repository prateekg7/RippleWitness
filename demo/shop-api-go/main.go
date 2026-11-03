// Minimal stdlib-only subject for the Go lifecycle smoke test (IT-REP-GO-01).
// Deterministic: fixed SKU order (no map iteration in output), in-memory cart,
// no wall clock. Boot contract: $PORT, readiness GET /health -> 200.
package main

import (
	"encoding/json"
	"net/http"
	"os"
)

var prices = []struct {
	SKU   string `json:"sku"`
	Price int    `json:"price"`
}{
	{"SKU-1", 100},
	{"SKU-2", 50},
}

var cartTotal int

func priceOf(sku string) int {
	for _, p := range prices {
		if p.SKU == sku {
			return p.Price
		}
	}
	return 0
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /products", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, prices)
	})
	mux.HandleFunc("POST /cart/add", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			SKU string `json:"sku"`
			Qty int    `json:"qty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		lineTotal := priceOf(body.SKU) * body.Qty
		cartTotal += lineTotal
		writeJSON(w, map[string]int{"lineTotal": lineTotal, "cartTotal": cartTotal})
	})
	mux.HandleFunc("GET /reports/total", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]int{"total": cartTotal})
	})
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	_ = http.ListenAndServe("127.0.0.1:"+port, mux)
}

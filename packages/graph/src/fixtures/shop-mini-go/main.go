package main

import (
	"database/sql"
	"net/http"
	"os"
)

func helper(x int) int { return x * 2 }

func handleA(w http.ResponseWriter, r *http.Request) {
	_ = helper(1)
	_ = os.Getenv("RATE")
}

func handleB(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		_, _ = db.Exec("INSERT INTO orders VALUES (1)")
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /a", handleA)
	var db *sql.DB
	mux.HandleFunc("POST /b/{id}", handleB(db))
	mux.HandleFunc("GET /anon", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("hi"))
	})
	_ = mux
}

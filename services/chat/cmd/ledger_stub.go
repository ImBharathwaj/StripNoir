package main

import (
	"net/http"
)

// Ledger extraction stub — money paths stay authoritative in Node until a dedicated service ships.

func ledgerHealthHandler(internalKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		if internalKey != "" && r.Header.Get("x-internal-key") != internalKey {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized internal"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"service": "stripnoir-ledger-stub",
			"status":  "not_implemented",
			"note":    "Use Node credit_ledger; see docs/operations/Phase6_Extraction.md",
		})
	}
}

func ledgerTransferStubHandler(internalKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		if internalKey != "" && r.Header.Get("x-internal-key") != internalKey {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized internal"})
			return
		}
		writeJSON(w, http.StatusNotImplemented, map[string]any{
			"error":  "ledger microservice not enabled",
			"status": "not_implemented",
		})
	}
}

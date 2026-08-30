package domain

import "testing"

func TestParseShareURL(t *testing.T) {
	ref, err := ParseShareURL("https://send.vis.ee/download/0123456789abcdef/#abc_-")
	if err != nil {
		t.Fatal(err)
	}
	if ref.Host != "https://send.vis.ee" {
		t.Fatalf("host %q", ref.Host)
	}
	if ref.ID != "0123456789abcdef" {
		t.Fatalf("id %q", ref.ID)
	}
	if ref.Secret != "abc_-" {
		t.Fatalf("secret %q", ref.Secret)
	}
}

func TestParseShareURLBareID(t *testing.T) {
	ref, err := ParseShareURL("0123456789ab")
	if err != nil {
		t.Fatal(err)
	}
	if ref.ID != "0123456789ab" {
		t.Fatal(ref.ID)
	}
}

func TestParseShareURLRejects(t *testing.T) {
	if _, err := ParseShareURL("https://send.vis.ee/other/abc"); err == nil {
		t.Fatal("expected error")
	}
	if _, err := ParseShareURL("not a url"); err == nil {
		t.Fatal("expected error")
	}
}

func TestBuildShareURL(t *testing.T) {
	got := BuildShareURL("https://send.vis.ee/", "0123456789abcdef", "sec")
	want := "https://send.vis.ee/download/0123456789abcdef/#sec"
	if got != want {
		t.Fatalf("%q", got)
	}
}

func TestWebSocketURL(t *testing.T) {
	got, err := WebSocketURL("https://send.vis.ee")
	if err != nil {
		t.Fatal(err)
	}
	if got != "wss://send.vis.ee/api/ws" {
		t.Fatalf("%q", got)
	}
}

func TestValidFileID(t *testing.T) {
	if !ValidFileID("0123456789") {
		t.Fatal("10 hex")
	}
	if ValidFileID("xyz") {
		t.Fatal("xyz")
	}
}

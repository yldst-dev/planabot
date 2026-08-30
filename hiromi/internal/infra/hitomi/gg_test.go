package hitomi

import "testing"

const sampleGG = `gg = { m: function(g) {
var o = 0;
switch (g) {
case 20:
case 2120:
case 553:
o = 1; break;
}
return o;
},
s: function(h) { var m = /(..)(.)$/.exec(h); return parseInt(m[2]+m[1], 16).toString(10); },
b: '1788012002/'
};`

func TestParseGG(t *testing.T) {
	r, err := parseGG(sampleGG)
	if err != nil {
		t.Fatal(err)
	}
	if r.basePath != "1788012002" {
		t.Fatalf("base %q", r.basePath)
	}
	if r.defaultVal != 0 {
		t.Fatalf("default %d", r.defaultVal)
	}
	if r.subdomainNum(553) != 2 {
		t.Fatalf("553 -> %d", r.subdomainNum(553))
	}
	if r.subdomainNum(1) != 1 {
		t.Fatalf("1 -> %d", r.subdomainNum(1))
	}
}

func TestHashCode(t *testing.T) {
	code, err := hashCode("8d0f5c4f040555966b1d757828071b7a68b2106df1bd27a428740ed993eb8292")
	if err != nil {
		t.Fatal(err)
	}
	if code != 553 {
		t.Fatalf("got %d", code)
	}
}

func TestThumbDir(t *testing.T) {
	dir, err := thumbDir("8d0f5c4f040555966b1d757828071b7a68b2106df1bd27a428740ed993eb8292")
	if err != nil {
		t.Fatal(err)
	}
	if dir != "2/29" {
		t.Fatalf("got %q", dir)
	}
}

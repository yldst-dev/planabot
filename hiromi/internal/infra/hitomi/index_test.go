package hitomi

import (
	"encoding/binary"
	"testing"
)

func TestDecodeNodeRoundTrip(t *testing.T) {
	buf := make([]byte, maxNodeSize)
	pos := 0
	binary.BigEndian.PutUint32(buf[pos:], 1)
	pos += 4
	binary.BigEndian.PutUint32(buf[pos:], 4)
	pos += 4
	copy(buf[pos:], []byte{1, 2, 3, 4})
	pos += 4
	binary.BigEndian.PutUint32(buf[pos:], 1)
	pos += 4
	binary.BigEndian.PutUint64(buf[pos:], 99)
	pos += 8
	binary.BigEndian.PutUint32(buf[pos:], 16)
	pos += 4
	for i := 0; i < 17; i++ {
		binary.BigEndian.PutUint64(buf[pos:], 0)
		pos += 8
	}
	n, err := decodeNode(buf)
	if err != nil {
		t.Fatal(err)
	}
	if len(n.keys) != 1 || n.keys[0][0] != 1 {
		t.Fatalf("keys %+v", n.keys)
	}
	if len(n.data) != 1 || n.data[0].offset != 99 || n.data[0].length != 16 {
		t.Fatalf("data %+v", n.data)
	}
	if !n.isLeaf() {
		t.Fatal("expected leaf")
	}
	idx, exact := n.find([]byte{1, 2, 3, 4})
	if !exact || idx != 0 {
		t.Fatalf("find %d %v", idx, exact)
	}
}

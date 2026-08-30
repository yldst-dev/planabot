package hitomi

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
)

const maxNodeSize = 464

type indexNode struct {
	keys     [][]byte
	data     []indexData
	subnodes []uint64
}

type indexData struct {
	offset uint64
	length int
}

func hashTerm(term string) []byte {
	sum := sha256.Sum256([]byte(term))
	return sum[:4]
}

func decodeNode(data []byte) (*indexNode, error) {
	if len(data) < 8 {
		return nil, fmt.Errorf("node too small")
	}
	n := &indexNode{}
	pos := 0
	keyCount := int(int32(binary.BigEndian.Uint32(data[pos:])))
	pos += 4
	for i := 0; i < keyCount; i++ {
		if pos+4 > len(data) {
			return nil, fmt.Errorf("truncated key size")
		}
		keySize := int(int32(binary.BigEndian.Uint32(data[pos:])))
		pos += 4
		if keySize < 1 || keySize > 31 {
			return nil, fmt.Errorf("invalid key size %d", keySize)
		}
		if pos+keySize > len(data) {
			return nil, fmt.Errorf("truncated key")
		}
		key := make([]byte, keySize)
		copy(key, data[pos:pos+keySize])
		n.keys = append(n.keys, key)
		pos += keySize
	}
	if pos+4 > len(data) {
		return nil, fmt.Errorf("truncated data count")
	}
	dataCount := int(int32(binary.BigEndian.Uint32(data[pos:])))
	pos += 4
	for i := 0; i < dataCount; i++ {
		if pos+12 > len(data) {
			return nil, fmt.Errorf("truncated data")
		}
		off := binary.BigEndian.Uint64(data[pos:])
		pos += 8
		length := int(int32(binary.BigEndian.Uint32(data[pos:])))
		pos += 4
		n.data = append(n.data, indexData{offset: off, length: length})
	}
	for i := 0; i < 17; i++ {
		if pos+8 > len(data) {
			return nil, fmt.Errorf("truncated subnode")
		}
		n.subnodes = append(n.subnodes, binary.BigEndian.Uint64(data[pos:]))
		pos += 8
	}
	return n, nil
}

func compareBuffers(a, b []byte) int {
	return bytes.Compare(a, b)
}

func (n *indexNode) find(key []byte) (index int, exact bool) {
	for index < len(n.keys) {
		cmp := compareBuffers(key, n.keys[index])
		if cmp == 0 {
			return index, true
		}
		if cmp < 0 {
			return index, false
		}
		index++
	}
	return index, false
}

func (n *indexNode) isLeaf() bool {
	for _, addr := range n.subnodes {
		if addr != 0 {
			return false
		}
	}
	return true
}

package hitomi

import (
	"context"
	"fmt"

	"hiromi/internal/domain"
)

func (c *Client) SearchTitle(ctx context.Context, terms []string) ([]uint64, error) {
	if len(terms) == 0 {
		return nil, nil
	}
	var acc map[uint64]struct{}
	for _, term := range terms {
		ids, err := c.searchGalleriesIndex(ctx, term)
		if err != nil {
			return nil, err
		}
		if acc == nil {
			acc = idSet(ids)
			continue
		}
		intersectIDs(acc, idSet(ids))
		if len(acc) == 0 {
			return nil, nil
		}
	}
	return setToIDs(acc), nil
}

func (c *Client) searchGalleriesIndex(ctx context.Context, term string) ([]uint64, error) {
	ver, err := c.indexVersion(ctx, "galleries")
	if err != nil {
		return nil, err
	}
	root, err := c.nodeAt(ctx, "galleries", ver, 0)
	if err != nil {
		return nil, err
	}
	if root == nil || len(root.keys) == 0 {
		return nil, domain.ErrEmptyIndex
	}
	data, err := c.binarySearch(ctx, "galleries", ver, hashTerm(term), root)
	if err != nil {
		return nil, err
	}
	if data == nil {
		return nil, nil
	}
	start := data.offset + 4
	end := data.offset + uint64(data.length) - 1
	if end < start {
		return nil, nil
	}
	body, _, _, err := c.getBytes(ctx, c.ltnURL("/galleriesindex/galleries."+ver+".data"), fmt.Sprintf("bytes=%d-%d", start, end), "")
	if err != nil {
		return nil, err
	}
	return decodeNozomi(body), nil
}

func (c *Client) nodeAt(ctx context.Context, field, version string, address uint64) (*indexNode, error) {
	start := address
	end := address + maxNodeSize - 1
	path := fmt.Sprintf("/%sindex/%s.%s.index", field, field, version)
	body, _, _, err := c.getBytes(ctx, c.ltnURL(path), fmt.Sprintf("bytes=%d-%d", start, end), "")
	if err != nil {
		return nil, err
	}
	if len(body) == 0 {
		return nil, nil
	}
	return decodeNode(body)
}

func (c *Client) binarySearch(ctx context.Context, field, version string, key []byte, node *indexNode) (*indexData, error) {
	if node == nil || len(node.keys) == 0 {
		return nil, nil
	}
	index, exact := node.find(key)
	if exact {
		if index >= len(node.data) {
			return nil, nil
		}
		d := node.data[index]
		return &d, nil
	}
	if node.isLeaf() {
		return nil, nil
	}
	if index >= len(node.subnodes) || node.subnodes[index] == 0 {
		return nil, nil
	}
	sub, err := c.nodeAt(ctx, field, version, node.subnodes[index])
	if err != nil {
		return nil, err
	}
	return c.binarySearch(ctx, field, version, key, sub)
}

func (c *Client) languageMask(ctx context.Context, term string) (uint64, error) {
	ver, err := c.indexVersion(ctx, "languages")
	if err != nil {
		return 0, err
	}
	root, err := c.nodeAt(ctx, "languages", ver, 0)
	if err != nil {
		return 0, err
	}
	if root == nil {
		return 0, domain.ErrEmptyIndex
	}
	data, err := c.binarySearch(ctx, "languages", ver, hashTerm(term), root)
	if err != nil {
		return 0, err
	}
	if data == nil {
		return 0, domain.ErrNotFound
	}
	return data.offset, nil
}
